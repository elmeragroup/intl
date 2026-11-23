import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { existsSync, linkSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

import { CatalogFiles, NODE_CATALOG_FILES } from "../src/catalog-files";
import type { ExtractOptions } from "../src/commands";
import { extractCatalogs, planCatalogs, writeCatalogs } from "../src/commands";
import type { ProjectConfig } from "../src/project-config";
import type { SyncResult, WatchMode } from "../src/watch";
import type { Project } from "./project-fixture";
import { component, deliveredEvents, it, startWatch, syncing } from "./watch-project";

// The saves the watch keeps: a translator's editor saves a catalog while a sync runs, and the sync never writes over it;
// the next sync merges it. Unit under test: `watchCatalogs` with the real `CatalogSync`, on the test clock, its catalogs
// on Node's files, with a hook after a storage operation where a case saves. Oracle: the contract per case, by hand: a
// msgstr saved during a sync survives and the next sync merges it; every catalog a sync wrote is reported and taken
// for the watch's own write; locales that share one catalog write it in turn, the last locale's text left.
describe("extract --watch keeps a catalog saved during a sync", () => {
  // Native file events, which a test delivers itself through `deliveredEvents`.
  const NATIVE: WatchMode = { _tag: "native" };
  const TWO_LOCALES = `{ "include": ["src/**/*.{ts,tsx}"], "catalogs": "messages/{locale}.po", "locales": ["nb", "sv"] }`;

  // Node's catalog files, each operation wrapped by `wrap`: a test's hook after one of a sync's storage operations.
  const wrapped = (
    wrap: (live: CatalogFiles["Service"]) => CatalogFiles["Service"]
  ): Layer.Layer<CatalogFiles> =>
    Layer.effect(
      CatalogFiles,
      CatalogFiles.use((live) => Effect.succeed(wrap(live)))
    ).pipe(Layer.provide(CatalogFiles.layer()));

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

  // A translator's save of "Hello" in `po`, as its editor writes it.
  const translate = (project: Project, po: string, text: string) => {
    project.write(
      po,
      project.read(po).replace(`msgid "Hello"\nmsgstr ""`, `msgid "Hello"\nmsgstr "${text}"`)
    );
  };

  // Node's catalog files, translating "Hello" in `po` right after the first read of it once `armed` is called, and
  // recording whether any write after the save dropped it.
  const savingAfterRead = (project: Project, po: string) => {
    const path = project.path(po);
    let armed = false;
    let saved = false;
    let overwritten = false;
    const layer = wrapped((live) => ({
      ...live,
      write: (written, text, guard) =>
        live.write(written, text, guard).pipe(
          Effect.tap((outcome) =>
            Effect.sync(() => {
              overwritten ||=
                saved && written === path && outcome === "written" && !text.includes(`msgstr "Hei"`);
            })
          )
        ),
      read: (read) =>
        live.read(read).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (armed && !saved && read === path) {
                saved = true;
                translate(project, po, "Hei");
              }
            })
          )
        ),
    }));

    return {
      layer,
      arm: () => {
        armed = true;
      },
      saved: () => saved,
      overwritten: () => overwritten,
    };
  };

  // Node's catalog files, saving sv's "Hello" right after the sync writes nb with "Ready" in it.
  const savingAfterNb = (project: Project) => {
    const nb = project.path("messages/nb.po");
    let saved = false;
    const layer = wrapped((live) => ({
      ...live,
      write: (path, text, guard) =>
        live.write(path, text, guard).pipe(
          Effect.tap((outcome) =>
            Effect.sync(() => {
              if (!saved && outcome === "written" && path === nb && text.includes(`msgid "Ready"`)) {
                saved = true;
                translate(project, "messages/sv.po", "Hej");
              }
            })
          )
        ),
    }));

    return { layer, saved: () => saved };
  };

  // A save that lands right after the sync's writes, inside the sync step: the next sync merges it rather than writing
  // the PO it read before.
  it.effect("keeps a msgstr saved right after the sync that added its message", ({ project }) =>
    Effect.gen(function* () {
      const po = project.path("messages/nb.po");
      let saved = false;
      yield* startWatch(project, {
        layer: syncing(
          Effect.fnUntraced(function* (config: ProjectConfig, options: ExtractOptions) {
            const result = yield* extractCatalogs(config, options);
            const added = result.written.find(
              ({ path, text }) => path === po && text.includes(`msgid "Ready"`)
            );

            if (!saved && added !== undefined) {
              saved = true;
              project.write(
                "messages/nb.po",
                added.text.replace(`msgid "Ready"\nmsgstr ""`, `msgid "Ready"\nmsgstr "Klar"`)
              );
            }

            return result;
          })
        ),
      });
      project.write("src/ready.tsx", component("Ready"));
      yield* TestClock.adjust("1 second");
      expect(project.read("messages/nb.po")).toContain(`msgid "Ready"\nmsgstr "Klar"`);

      project.write("src/after.tsx", component("After"));
      yield* TestClock.adjust("1 second");
      expect(project.read("messages/nb.po")).toContain(`msgid "Ready"\nmsgstr "Klar"`);
      expect(project.read("messages/nb.po")).toContain(`msgid "After"`);
    })
  );

  // A save that lands after a sync read the PO and before it writes: the sync yields, and the next one merges the save.
  it.effect("keeps a msgstr saved while a sync runs", ({ project }) =>
    Effect.gen(function* () {
      const po = project.path("messages/nb.po");
      let saved = false;
      yield* startWatch(project, {
        layer: syncing(
          Effect.fnUntraced(function* (config: ProjectConfig, options: ExtractOptions) {
            const plan = yield* planCatalogs(config, options);

            if (
              !saved &&
              plan.outputs.some(({ path, text }) => path === po && text.includes(`msgid "Ready"`))
            ) {
              saved = true;
              translate(project, "messages/nb.po", "Hei");
            }

            return yield* writeCatalogs(plan, options);
          })
        ),
      });
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
  // then holds a text the sync wrote, but to another file: the sync's write of sv finds it changed and stops, and the
  // next sync merges the copy.
  it.effect("keeps a catalog copied onto another while the sync writes the one it copies", ({ project }) =>
    Effect.gen(function* () {
      project.write("elmera-intl.json", TWO_LOCALES);
      const nb = project.path("messages/nb.po");
      let copied = false;
      const files = wrapped((live) => ({
        ...live,
        write: (path, text, guard) =>
          live.write(path, text, guard).pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                if (!copied && outcome === "written" && path === nb && text.includes(`msgid "Ready"`)) {
                  copied = true;
                  project.write("messages/sv.po", project.read("messages/nb.po"));
                }
              })
            )
          ),
      }));
      const { reports } = yield* startWatch(project, { files });
      translate(project, "messages/nb.po", "Hei");
      yield* TestClock.adjust("1 second");
      project.write("src/ready.tsx", component("Ready"));
      yield* TestClock.adjust("1 second");

      expect({ copied, reports }).toEqual({
        copied: true,
        reports: ["Written", "Unchanged", "Written", "Written"],
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

  // Every catalog the superseded sync wrote is reported and recorded as the watch's own: nb's own change event,
  // delivered only after the follow-up sync, starts no sync.
  it.effect("reports and records what a superseded sync wrote", ({ project }) =>
    Effect.gen(function* () {
      project.write("elmera-intl.json", TWO_LOCALES);
      const events = deliveredEvents();
      const reports = recorded(project);
      yield* startWatch(project, {
        files: savingAfterNb(project).layer,
        mode: NATIVE,
        events: events.layer,
        report: reports.report,
      });
      project.write("src/ready.tsx", component("Ready"));
      events.listener(project.root).change("rename", "src/ready.tsx");
      yield* TestClock.adjust("1 second");
      events.listener(project.root).change("change", "messages/nb.po");
      yield* TestClock.adjust("1 second");

      expect(reports.lines).toEqual([
        "wrote messages/nb.po, messages/sv.po",
        "wrote messages/nb.po",
        "wrote messages/sv.po",
      ]);
    })
  );

  // Paths that name one file are read once per sync: a save after that read is seen by the check before the writes,
  // whichever locale names the file again later, so no output merged from the earlier text is ever written over it
  // (not even for a moment, before a later locale's output merged from the save).
  it.effect.each([
    {
      alias: "a duplicate locale",
      config: `{ "include": ["src/**/*.{ts,tsx}"], "catalogs": "messages/{locale}.po", "locales": ["nb", "sv", "nb"] }`,
      po: "messages/nb.po",
    },
    {
      alias: "a {locale}/.. path",
      config: `{ "include": ["src/**/*.{ts,tsx}"], "catalogs": "messages/{locale}/../catalog.po", "locales": ["nb", "nested/fr", "sv"] }`,
      po: "messages/catalog.po",
    },
  ])("keeps a msgstr saved after the one read of a file $alias names again", ({ config, po }, { project }) =>
    Effect.gen(function* () {
      project.write("elmera-intl.json", config);
      const saving = savingAfterRead(project, po);
      yield* startWatch(project, { files: saving.layer });
      saving.arm();
      project.write("src/ready.tsx", component("Ready"));
      yield* TestClock.adjust("1 second");

      expect({ saved: saving.saved(), overwritten: saving.overwritten() }).toEqual({
        saved: true,
        overwritten: false,
      });
      expect(project.read(po)).toMatch(/msgid "Hello"\nmsgstr "Hei"[\s\S]*msgid "Ready"/u);
    })
  );

  // Locales whose catalogs are links to one file write it in turn, as the layer 4 watch did (62bfdb1): every write
  // reported, and the file left with the last locale's catalog.
  it.effect("writes a catalog a symbolic link names, after the file it links to", ({ project }) =>
    Effect.gen(function* () {
      project.write("elmera-intl.json", TWO_LOCALES);
      mkdirSync(project.path("messages"));
      symlinkSync("nb.po", project.path("messages/sv.po"));
      const reports = recorded(project);
      yield* startWatch(project, { report: reports.report });

      expect(reports.lines).toEqual(["wrote messages/nb.po, messages/sv.po"]);
      expect(project.read("messages/nb.po")).toContain(String.raw`"Language: sv\n"`);
    })
  );

  it.effect("writes catalogs that are hard links to one file, each in turn", ({ project }) =>
    Effect.gen(function* () {
      project.write(
        "elmera-intl.json",
        `{ "include": ["src/**/*.{ts,tsx}"], "catalogs": "messages/{locale}.po", "locales": ["nb", "sv", "da"] }`
      );
      project.write("messages/nb.po", "");
      linkSync(project.path("messages/nb.po"), project.path("messages/sv.po"));
      linkSync(project.path("messages/nb.po"), project.path("messages/da.po"));
      const reports = recorded(project);
      yield* startWatch(project, { report: reports.report });

      expect(reports.lines).toEqual(["wrote messages/nb.po, messages/sv.po, messages/da.po"]);
      expect(project.read("messages/sv.po")).toContain(String.raw`"Language: da\n"`);
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
      project.write(
        "elmera-intl.json",
        `{ "include": ["src/**/*.{ts,tsx}"], "catalogs": "${project.root}/messages/jump/../{locale}.po", "locales": ["nb"] }`
      );
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

  // Two locales whose names a case-insensitive file system folds into one file: the second write finds the first's
  // text, the sync's own, so both are written and reported, as at 62bfdb1, and the file holds the last locale's.
  it.effect(
    "writes catalogs whose names a case-insensitive file system folds, each in turn",
    ({ project, skip }) =>
      Effect.gen(function* () {
        project.write("case-probe", "");

        if (!existsSync(project.path("CASE-PROBE"))) {
          skip("the file system under the test's root is case-sensitive");
        }

        project.write(
          "elmera-intl.json",
          `{ "include": ["src/**/*.{ts,tsx}"], "catalogs": "messages/{locale}.po", "locales": ["nb", "NB"] }`
        );
        const reports = recorded(project);
        yield* startWatch(project, { report: reports.report });

        expect(reports.lines).toEqual(["wrote messages/nb.po, messages/NB.po"]);
        expect(project.read("messages/nb.po")).toContain(String.raw`"Language: NB\n"`);
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

  // Locales whose catalogs are one file: each locale's output is written in turn, each compared with the sync's own
  // write before it, so the sync is not superseded by itself and the last locale's catalog is what the file holds.
  it.effect("writes one catalog that several locales share, in turn", ({ project }) =>
    Effect.gen(function* () {
      project.write(
        "elmera-intl.json",
        `{ "include": ["src/**/*.{ts,tsx}"], "catalogs": "messages/{locale}/../catalog.po", "locales": ["nb", "sv"] }`
      );
      const { reports } = yield* startWatch(project);
      yield* TestClock.adjust("1 second");

      expect(reports).toEqual(["Written"]);
      expect(project.read("messages/catalog.po")).toContain(String.raw`"Language: sv\n"`);
    })
  );
});
