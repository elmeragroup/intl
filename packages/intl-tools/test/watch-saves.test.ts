import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { existsSync, linkSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

import { CatalogFiles, NODE_CATALOG_FILES } from "../src/catalog-files";
import { formatPo } from "../src/po";
import type { SyncResult, WatchMode } from "../src/watch";
import type { Project } from "./project-fixture";
import {
  afterCatalogWrite,
  CONFIG,
  component,
  deliveredEvents,
  it,
  startWatch,
  wrapped,
} from "./watch-project";

// The saves the watch keeps: a translator's editor saves a catalog while a sync runs, and the sync never writes over it;
// the next sync merges it. Unit under test: `watchCatalogs` with the real `CatalogSync`, on the test clock, its catalogs
// on Node's files, with a hook after a storage operation where a case saves. Oracle: the contract per case, by hand: a
// msgstr saved during a sync survives and the next sync merges it; every catalog a sync wrote is reported and taken
// for the watch's own write; locales that share one catalog write it in turn, the last locale's text left.
describe("extract --watch keeps a catalog saved during a sync", () => {
  // Native file events, which a test delivers itself through `deliveredEvents`.
  const NATIVE: WatchMode = { _tag: "native" };
  const TWO_LOCALES = `{ "include": ["src/**/*.{ts,tsx}"], "catalogs": "messages/{locale}.po", "locales": ["nb", "sv"] }`;

  // Each result as the CLI's watch prints it (`wrote` and the files, relative to the root), or its tag.
  const recorded = (project: Project) => {
    const lines: Array<string> = [];
    const report = (result: SyncResult) =>
      Effect.sync(() => {
        lines.push(
          result._tag === "Written"
            ? `wrote ${result.files.map((file) => relative(project.root, file)).join(", ")}`
            : result._tag
        );
      });

    return { lines, report };
  };

  // The project's config: the base one with `fields` over it, serialized so any character in a path stays a string.
  const configure = (project: Project, fields: Partial<typeof CONFIG>) => {
    project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, ...fields }));
  };

  // A translator's save of "Hello" in `po`, as its editor writes it.
  const translate = (project: Project, po: string, text: string) => {
    project.write(
      po,
      project.read(po).replace(`msgid "Hello"\nmsgstr ""`, `msgid "Hello"\nmsgstr "${text}"`)
    );
  };

  // Node's catalog files, saving sv's "Hello" right after the sync writes nb with "Ready" in it.
  const savingAfterNb = (project: Project) => {
    let saved = false;
    const layer = afterCatalogWrite(
      project.path("messages/nb.po"),
      () => {
        saved = true;
        translate(project, "messages/sv.po", "Hej");
      },
      (text) => text.includes(`msgid "Ready"`)
    );

    return { layer, saved: () => saved };
  };

  // A save that lands right after the sync's writes, before the sync takes its record (a tap on the storage's write):
  // it is no text of the sync's own, so it starts a sync of its own, which merges it rather than writing the PO it read
  // before.
  it.effect("keeps a msgstr saved right after the sync that added its message", ({ project }) =>
    Effect.gen(function* () {
      let saved = false;
      const files = afterCatalogWrite(
        project.path("messages/nb.po"),
        (text) => {
          saved = true;
          project.write(
            "messages/nb.po",
            text.replace(`msgid "Ready"\nmsgstr ""`, `msgid "Ready"\nmsgstr "Klar"`)
          );
        },
        (text) => text.includes(`msgid "Ready"`)
      );
      const { reports } = yield* startWatch(project, { files });
      project.write("src/ready.tsx", component("Ready"));
      yield* TestClock.adjust("1 second");
      expect({ saved, reports: [...reports] }).toEqual({
        saved: true,
        reports: ["Written", "Written", "Unchanged"],
      });
      expect(project.read("messages/nb.po")).toContain(`msgid "Ready"\nmsgstr "Klar"`);

      project.write("src/after.tsx", component("After"));
      yield* TestClock.adjust("1 second");
      expect(project.read("messages/nb.po")).toContain(`msgid "Ready"\nmsgstr "Klar"`);
      expect(project.read("messages/nb.po")).toContain(`msgid "After"`);
    })
  );

  // A save that lands after a sync read the PO and before it writes (a tap on the storage's first read of nb once the
  // new source exists, the sync's snapshot): the sync yields, and the next one merges the save.
  it.effect("keeps a msgstr saved while a sync runs", ({ project }) =>
    Effect.gen(function* () {
      const po = project.path("messages/nb.po");
      let saved = false;
      const files = wrapped((live) => ({
        ...live,
        read: (path) =>
          live.read(path).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (!saved && path === po && existsSync(project.path("src/ready.tsx"))) {
                  saved = true;
                  translate(project, "messages/nb.po", "Hei");
                }
              })
            )
          ),
      }));
      yield* startWatch(project, { files });
      project.write("src/ready.tsx", component("Ready"));
      yield* TestClock.adjust("1 second");
      expect(project.read("messages/nb.po")).toContain(`msgid "Hello"\nmsgstr "Hei"`);
      expect(project.read("messages/nb.po")).toContain(`msgid "Ready"`);
    })
  );

  // The save lands on sv after the sync wrote nb and before it writes sv. Through the real `CatalogSync`: the sync's
  // write of sv finds it changed and stops, nb's write reported, and the next sync merges the save.
  it.effect("keeps a msgstr saved in one catalog while the sync writes another", ({ project }) =>
    Effect.gen(function* () {
      project.write("elmera-intl.json", TWO_LOCALES);
      const saving = savingAfterNb(project);
      const { reports } = yield* startWatch(project, { files: saving.layer });
      project.write("src/ready.tsx", component("Ready"));
      yield* TestClock.adjust("1 second");

      expect(project.read("messages/sv.po")).toMatch(/msgid "Hello"\nmsgstr "Hej"[\s\S]*msgid "Ready"/u);
      expect({ saved: saving.saved(), reports }).toEqual({
        saved: true,
        reports: ["Written", "Written", "Written"],
      });
    })
  );

  // A translator seeds sv from nb, copying nb's catalog onto sv's after the sync wrote nb and before it writes sv. sv
  // then holds a text the sync wrote, but to another file: the sync's write of sv finds it changed and stops, having
  // written nb alone, and the next sync merges the copy, writing sv alone.
  it.effect("keeps a catalog copied onto another while the sync writes the one it copies", ({ project }) =>
    Effect.gen(function* () {
      project.write("elmera-intl.json", TWO_LOCALES);
      const reports = recorded(project);
      let copied = false;
      const files = afterCatalogWrite(
        project.path("messages/nb.po"),
        () => {
          copied = true;
          project.write("messages/sv.po", project.read("messages/nb.po"));
        },
        (text) => text.includes(`msgid "Ready"`)
      );
      yield* startWatch(project, { files, report: reports.report });
      translate(project, "messages/nb.po", "Hei");
      yield* TestClock.adjust("1 second");
      project.write("src/ready.tsx", component("Ready"));
      yield* TestClock.adjust("1 second");

      expect({ copied, lines: reports.lines }).toEqual({
        copied: true,
        lines: [
          "wrote messages/nb.po, messages/sv.po",
          "Unchanged",
          "wrote messages/nb.po",
          "wrote messages/sv.po",
        ],
      });
      expect(project.read("messages/sv.po")).toMatch(/msgid "Hello"\nmsgstr "Hei"[\s\S]*msgid "Ready"/u);
    })
  );

  // The runtime yields to another fiber at any step of a sync. A fiber that saves sv just after the sync's storage
  // operation on it (once nb is written) runs at that yield: the check of sv and its write are one operation, so the
  // save lands after the write, never between them, and the next sync merges it.
  it.effect(
    "keeps a msgstr another fiber saves while the sync yields between catalog operations",
    ({ project }) =>
      Effect.gen(function* () {
        project.write("elmera-intl.json", TWO_LOCALES);
        const nb = project.path("messages/nb.po");
        const sv = project.path("messages/sv.po");
        let nbWritten = false;
        let saved = false;
        // After an operation on sv, once nb holds "Ready": another fiber saves sv, and the sync yields to it.
        const yieldingToSave = Effect.suspend(() => {
          if (saved || !nbWritten) {
            return Effect.void;
          }

          saved = true;

          return Effect.forkChild(Effect.sync(() => translate(project, "messages/sv.po", "Hej"))).pipe(
            Effect.andThen(Effect.yieldNow)
          );
        });
        const files = wrapped((live) => ({
          ...live,
          read: (path) =>
            live.read(path).pipe(Effect.tap(() => (path === sv ? yieldingToSave : Effect.void))),
          write: (path, text, guard) =>
            live.write(path, text, guard).pipe(
              Effect.tap((outcome) =>
                Effect.suspend(() => {
                  nbWritten ||= outcome === "written" && path === nb && text.includes(`msgid "Ready"`);

                  return path === sv ? yieldingToSave : Effect.void;
                })
              )
            ),
        }));
        yield* startWatch(project, { files });
        project.write("src/ready.tsx", component("Ready"));
        yield* TestClock.adjust("1 second");

        expect(saved).toBe(true);
        expect(project.read("messages/sv.po")).toMatch(/msgid "Hello"\nmsgstr "Hej"[\s\S]*msgid "Ready"/u);
      })
  );

  // Within the guarded write too: a fiber that saves sv, started from the storage's own read of sv inside sv's guarded
  // write, runs at the sync's next yield, which comes only after the write.
  it.effect(
    "keeps a msgstr another fiber saves while the sync yields inside a guarded write",
    ({ project }) =>
      Effect.gen(function* () {
        project.write("elmera-intl.json", TWO_LOCALES);
        const nb = project.path("messages/nb.po");
        const sv = project.path("messages/sv.po");
        const context = yield* Effect.context();
        let nbWritten = false;
        let saved = false;
        const files = CatalogFiles.layer({
          ...NODE_CATALOG_FILES,
          read: (path) => {
            const text = NODE_CATALOG_FILES.read(path);

            if (path === sv && nbWritten && !saved) {
              saved = true;
              // Starts now and yields at once: it saves at the first yield of the fiber that read.
              Effect.runForkWith(context)(
                Effect.yieldNow.pipe(
                  Effect.andThen(Effect.sync(() => translate(project, "messages/sv.po", "Hej")))
                )
              );
            }

            return text;
          },
          write: (path, text) => {
            NODE_CATALOG_FILES.write(path, text);
            nbWritten ||= path === nb && text.includes(`msgid "Ready"`);
          },
        });
        yield* startWatch(project, { files });
        project.write("src/ready.tsx", component("Ready"));
        yield* TestClock.adjust("1 second");

        expect(saved).toBe(true);
        expect(project.read("messages/sv.po")).toMatch(/msgid "Hello"\nmsgstr "Hej"[\s\S]*msgid "Ready"/u);
      })
  );

  // A superseded sync records what it wrote as its own, and vouches for nothing else: the others' snapshots may be
  // stale, and through a link a catalog it never wrote may hold its write. nb is written, then sv's save supersedes the
  // sync before it writes sv or da; halfway through the retry's debounce, a change event arrives for one catalog. Oracle:
  // the contract by hand: the retry runs 100 ms after the last change. An event for nb, the sync's own write, is no
  // change, so the retry runs at its deadline, 100 ms after the superseded sync; an event for da, which it did not write,
  // is one, so at that deadline only the superseded sync is reported, and the retry follows 50 ms later. The retry then
  // completes, and nb.po, which it left as its snapshot, is its own: a second event for nb.po starts no sync.
  it.effect.each([
    {
      changed: "nb.po, which the sync wrote",
      setup: (project: Project) => {
        mkdirSync(project.path("messages"));
      },
      event: "nb.po",
      atRetryDue: ["wrote messages/nb.po", "wrote messages/sv.po, messages/da.po"],
    },
    {
      changed: "da.po, a catalog of its own still holding its snapshot",
      setup: (project: Project) => {
        mkdirSync(project.path("messages"));
      },
      event: "da.po",
      atRetryDue: ["wrote messages/nb.po"],
    },
    {
      changed: "da.po, a hard link to nb holding the sync's write",
      setup: (project: Project) => {
        project.write("messages/nb.po", "");
        linkSync(project.path("messages/nb.po"), project.path("messages/da.po"));
      },
      event: "da.po",
      atRetryDue: ["wrote messages/nb.po"],
    },
  ])(
    "times the retry after a superseded sync from a change to $changed",
    ({ setup, event, atRetryDue }, { project }) =>
      Effect.gen(function* () {
        project.write(
          "elmera-intl.json",
          `{ "include": ["src/**/*.{ts,tsx}"], "catalogs": "messages/{locale}.po", "locales": ["nb", "sv", "da"] }`
        );
        setup(project);
        const events = deliveredEvents();
        const reports = recorded(project);
        yield* startWatch(project, {
          files: savingAfterNb(project).layer,
          mode: NATIVE,
          events: events.layer,
          report: reports.report,
        });
        const started = reports.lines.length;
        project.write("src/ready.tsx", component("Ready"));
        events.listener(project.path("src")).change("rename", "ready.tsx");
        yield* TestClock.adjust("100 millis");
        const superseded = reports.lines.slice(started);
        yield* TestClock.adjust("50 millis");
        events.listener(project.path("messages")).change("change", event);
        yield* TestClock.adjust("50 millis");
        const atDeadline = reports.lines.slice(started);
        yield* TestClock.adjust("50 millis");
        const after = reports.lines.slice(started);
        events.listener(project.path("messages")).change("change", "nb.po");
        yield* TestClock.adjust("1 second");

        expect({ superseded, atDeadline, after, settled: reports.lines.slice(started) }).toEqual({
          superseded: ["wrote messages/nb.po"],
          atDeadline: atRetryDue,
          after: ["wrote messages/nb.po", "wrote messages/sv.po, messages/da.po"],
          settled: ["wrote messages/nb.po", "wrote messages/sv.po, messages/da.po"],
        });
      })
  );

  // Locales whose catalogs are links to one file write it in turn, as the layer 4 watch did (62bfdb1): every write
  // reported, and the file left with the last locale's catalog. That text differs from what the watch wrote to the
  // earlier locales' paths (each catalog's header names its locale), and those paths' change events must still read as
  // the watch's own (#15). Oracle: the contract by hand: the first sync's report and the last locale's header at once;
  // five debounces later, with no save and no source change, still that one sync; a new source then makes exactly one
  // more, and the file holds the last locale's catalog with it.
  it.effect.each([
    {
      link: "symbolic links",
      setup: (project: Project) => {
        mkdirSync(project.path("messages"));
        symlinkSync("nb.po", project.path("messages/sv.po"));
        symlinkSync("nb.po", project.path("messages/da.po"));
      },
    },
    {
      link: "hard links",
      setup: (project: Project) => {
        project.write("messages/nb.po", "");
        linkSync(project.path("messages/nb.po"), project.path("messages/sv.po"));
        linkSync(project.path("messages/nb.po"), project.path("messages/da.po"));
      },
    },
  ])(
    "takes its own writes through $link to one catalog for its own, and syncs no more",
    ({ setup }, { project }) =>
      Effect.gen(function* () {
        project.write(
          "elmera-intl.json",
          `{ "include": ["src/**/*.{ts,tsx}"], "catalogs": "messages/{locale}.po", "locales": ["nb", "sv", "da"] }`
        );
        setup(project);
        const reports = recorded(project);
        yield* startWatch(project, { report: reports.report });

        expect(reports.lines).toEqual(["wrote messages/nb.po, messages/sv.po, messages/da.po"]);
        expect(project.read("messages/sv.po")).toContain(String.raw`"Language: da\n"`);
        for (let debounce = 0; debounce < 5; debounce += 1) {
          yield* TestClock.adjust("1 second");
        }

        const settled = [...reports.lines];
        project.write("src/ready.tsx", component("Ready"));
        for (let debounce = 0; debounce < 5; debounce += 1) {
          yield* TestClock.adjust("1 second");
        }

        expect({ settled, after: reports.lines.slice(settled.length) }).toEqual({
          settled: ["wrote messages/nb.po, messages/sv.po, messages/da.po"],
          after: ["wrote messages/nb.po, messages/sv.po, messages/da.po"],
        });
        expect(project.read("messages/nb.po")).toMatch(/"Language: da\\n"[\s\S]*msgid "Ready"/u);
      })
  );

  // A linked group whose first path already holds its locale's catalog: the sync leaves nb.po, the file, as it is and
  // writes sv's catalog through the link. The watch records what each path reads back after the writes, the paths it
  // left included, so nb's change event finds its own record. Oracle: the contract by hand: five debounces after the
  // watch starts, its first sync, which wrote sv alone, is the only one.
  it.effect("takes a linked catalog it left unwritten for its own, and syncs no more", ({ project }) =>
    Effect.gen(function* () {
      project.write(
        "elmera-intl.json",
        `{ "include": ["src/**/*.{ts,tsx}"], "catalogs": "messages/{locale}.po", "locales": ["nb"] }`
      );
      const alone = yield* startWatch(project);
      yield* Scope.close(alone.scope, Exit.void);
      project.write("elmera-intl.json", TWO_LOCALES);
      symlinkSync("nb.po", project.path("messages/sv.po"));
      const reports = recorded(project);
      yield* startWatch(project, { report: reports.report });
      for (let debounce = 0; debounce < 5; debounce += 1) {
        yield* TestClock.adjust("1 second");
      }

      expect(reports.lines).toEqual(["wrote messages/sv.po"]);
    })
  );

  // A write to a catalog absent at the read can make another path reach a file through a link: here da's write creates
  // `messages/da`, so `sv/catalog.po -> ../da/../nb/catalog.po`, absent at the read, now names nb's catalog. The source
  // declares no message and nb's catalog holds da's empty one, so sv's guard finds da's text there (written to an absent
  // path: the sync's own), and once sv's write lands on it, nb's path, present at the read, holds a text this sync wrote
  // to a path that was absent: the sync's own, and nb is written too. Oracle: the contract by hand
  // (`isOwnWrite`): the first sync writes all three catalogs and is not superseded.
  it.effect(
    "takes its write through a link an absent catalog's write made reachable for its own",
    ({ project }) =>
      Effect.gen(function* () {
        project.write("src/page.tsx", `export const page = "no message";\n`);
        project.write("messages/nb/catalog.po", formatPo("da", []));
        mkdirSync(project.path("messages/sv"));
        symlinkSync("../da/../nb/catalog.po", project.path("messages/sv/catalog.po"));
        configure(project, { catalogs: "messages/{locale}/catalog.po", locales: ["da", "sv", "nb"] });
        const reports = recorded(project);
        yield* startWatch(project, { report: reports.report });

        expect(reports.lines).toEqual([
          "wrote messages/da/catalog.po, messages/sv/catalog.po, messages/nb/catalog.po",
        ]);
      })
  );

  // A translator copies a catalog the watch wrote onto another: nb.po, saved with "Ready" before its source, is left
  // as it is when the source arrives, and only sv.po is written; then nb's first text is copied over sv.po. The copy is
  // no text sv's path read back after the watch's writes, so it syncs. Oracle: the contract by hand: sv.po ends with
  // "Ready" again, written by the sync after the copy.
  it.effect("syncs a catalog another catalog's earlier text is copied onto", ({ project }) =>
    Effect.gen(function* () {
      project.write("elmera-intl.json", TWO_LOCALES);
      const reports = recorded(project);
      yield* startWatch(project, { report: reports.report });
      const first = project.read("messages/nb.po");
      project.write("messages/nb.po", `${first}\n#: src/ready.tsx\nmsgid "Ready"\nmsgstr ""\n`);
      project.write("src/ready.tsx", component("Ready"));
      yield* TestClock.adjust("1 second");
      const beforeCopy = [...reports.lines];
      project.write("messages/sv.po", first);
      for (let debounce = 0; debounce < 3; debounce += 1) {
        yield* TestClock.adjust("1 second");
      }

      expect({ beforeCopy, afterCopy: reports.lines.slice(beforeCopy.length) }).toEqual({
        beforeCopy: ["wrote messages/nb.po, messages/sv.po", "wrote messages/sv.po"],
        afterCopy: ["wrote messages/sv.po"],
      });
      expect(project.read("messages/sv.po")).toMatch(/"Language: sv\\n"[\s\S]*msgid "Ready"/u);
    })
  );

  // A translator copies one catalog onto another in the moment after the sync wrote both and before it read them back
  // for its record (a tap on the storage's write of sv): sv.po then holds nb's new text, which this sync wrote to
  // another path, one whose snapshot was another existing catalog. Oracle: the contract by hand: the record takes a
  // read-back only when it is a text this sync wrote over that path's own snapshot, so the copy is a change and starts
  // another sync. The sync that added "Ready" wrote both catalogs, and the one after the copy writes sv.po alone, which
  // ends with its own catalog again.
  it.effect(
    "syncs a catalog copied onto another between the sync's writes and its read-back",
    ({ project }) =>
      Effect.gen(function* () {
        project.write("elmera-intl.json", TWO_LOCALES);
        const reports = recorded(project);
        let copied = false;
        // Right after the sync writes sv, its last catalog, and before it takes its record.
        const files = afterCatalogWrite(
          project.path("messages/sv.po"),
          () => {
            copied = true;
            project.write("messages/sv.po", project.read("messages/nb.po"));
          },
          (text) => text.includes('msgid "Ready"')
        );
        yield* startWatch(project, { files, report: reports.report });
        project.write("src/ready.tsx", component("Ready"));
        for (let debounce = 0; debounce < 5; debounce += 1) {
          yield* TestClock.adjust("1 second");
        }

        expect({ copied, lines: reports.lines }).toEqual({
          copied: true,
          lines: [
            "wrote messages/nb.po, messages/sv.po",
            "wrote messages/nb.po, messages/sv.po",
            "wrote messages/sv.po",
          ],
        });
        expect(project.read("messages/sv.po")).toMatch(/"Language: sv\\n"[\s\S]*msgid "Ready"/u);
      })
  );

  // A link through a linked directory: `sv.po -> jump/../nb.po` with `jump -> ../other/sub` names `other/nb.po`, not
  // `messages/nb.po`. Each path is its own snapshot, so both writes are made and reported, as the layer 4 watch's were
  // (62bfdb1), and the file the link names exists once the watch is ready.
  it.effect("writes a catalog whose link resolves through a linked directory", ({ project }) =>
    Effect.gen(function* () {
      project.write("elmera-intl.json", TWO_LOCALES);
      mkdirSync(project.path("messages"));
      mkdirSync(project.path("other/sub"), { recursive: true });
      symlinkSync("../other/sub", project.path("messages/jump"));
      symlinkSync("jump/../nb.po", project.path("messages/sv.po"));
      const reports = recorded(project);
      yield* startWatch(project, { report: reports.report });

      expect(reports.lines).toEqual(["wrote messages/nb.po, messages/sv.po"]);
      expect(project.read("other/nb.po")).toContain(String.raw`"Language: sv\n"`);
    })
  );

  // An absolute catalog path through a linked directory: `messages/jump/../nb.po` with `jump -> ../other/sub` names
  // `other/nb.po`, while the string's lexical `messages/nb.po` is another file. The sync reads, checks and writes the
  // path as configured, so a new message reaches the file the path names, as at e5f111b.
  it.effect("adds a message to a catalog an absolute path names through a linked directory", ({ project }) =>
    Effect.gen(function* () {
      configure(project, { catalogs: `${project.root}/messages/jump/../{locale}.po` });
      mkdirSync(project.path("messages"));
      mkdirSync(project.path("other/sub"), { recursive: true });
      symlinkSync("../other/sub", project.path("messages/jump"));
      const { reports } = yield* startWatch(project);
      project.write("src/ready.tsx", component("Ready"));
      yield* TestClock.adjust("1 second");

      expect({ reports, nb: existsSync(project.path("messages/nb.po")) }).toEqual({
        reports: ["Written", "Written"],
        nb: false,
      });
      expect(project.read("other/nb.po")).toContain(`msgid "Ready"`);
    })
  );

  // An editor's atomic save (write a new file, rename it over the old) breaks a hard link: nb.po becomes a new file,
  // and da.po keeps the old one. The check before the first write reads every path, nb's included, so the sync is
  // superseded with nothing written, as at 62bfdb1, and the next sync merges the save.
  it.effect("writes nothing when an atomic save breaks a hard link after the plan", ({ project }) =>
    Effect.gen(function* () {
      project.write(
        "elmera-intl.json",
        `{ "include": ["src/**/*.{ts,tsx}"], "catalogs": "messages/{locale}.po", "locales": ["sv", "nb", "da"] }`
      );
      project.write("messages/nb.po", "");
      linkSync(project.path("messages/nb.po"), project.path("messages/da.po"));
      const da = project.path("messages/da.po");
      let armed = false;
      let saved = false;
      const files = wrapped((live) => ({
        ...live,
        read: (path) =>
          live.read(path).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (armed && !saved && path === da) {
                  saved = true;
                  const tmp = project.path("messages/nb.po.tmp");
                  writeFileSync(
                    tmp,
                    project
                      .read("messages/nb.po")
                      .replace(`msgid "Hello"\nmsgstr ""`, `msgid "Hello"\nmsgstr "Hei"`)
                  );
                  renameSync(tmp, project.path("messages/nb.po"));
                }
              })
            )
          ),
      }));
      const reports = recorded(project);
      yield* startWatch(project, { files, report: reports.report });
      armed = true;
      project.write("src/ready.tsx", component("Ready"));
      yield* TestClock.adjust("1 second");

      expect({ saved, lines: reports.lines.slice(0, 2) }).toEqual({
        saved: true,
        lines: ["wrote messages/sv.po, messages/nb.po, messages/da.po", "Superseded"],
      });
      expect(project.read("messages/nb.po")).toMatch(/msgid "Hello"\nmsgstr "Hei"[\s\S]*msgid "Ready"/u);
    })
  );
});
