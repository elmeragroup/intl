import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

import type { WatchMode } from "../src/watch";
import type { ChangeEvent } from "../src/watch-trees";
import type { Project } from "./project-fixture";
import type { DeliveredEvents } from "./watch-project";
import { component, CONFIG, deliveredEvents, it, POLLING, startWatch } from "./watch-project";

// Whether the volume the projects are made on folds case: a file written under one case found under another. Probed
// once as the file is collected, so a case-sensitive volume (Linux CI) skips the case rows before they start.
const FOLDS_CASE = (() => {
  const probe = mkdtempSync(join(tmpdir(), "elmera-intl-case-"));
  try {
    writeFileSync(join(probe, "case-probe"), "");

    return existsSync(join(probe, "CASE-PROBE"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

// A translator's save to a catalog, however the config spells the catalog's path (#89). Unit under test: `watchCatalogs`
// with the real `CatalogSync`, on the test clock, its catalogs on Node's files, in both modes: polling, whose walks read
// the real trees, and native events, which the test delivers as `fs.watch` names them. Oracle: the contract by hand: a
// save to a configured locale's catalog, wherever `extract` writes it, runs one sync, which finds the catalog's
// translation already merged (`Unchanged`); a save to a PO that is no configured catalog runs none.
describe("extract --watch syncs on a save to a catalog however its path is spelled", () => {
  const NATIVE: WatchMode = { _tag: "native" };
  const MODES = [
    { mode: "polling", watchMode: POLLING },
    { mode: "native events", watchMode: NATIVE },
  ] as const;

  // The project's config: the base one with `fields` over it, serialized so any character in a path stays a string.
  const configure = (project: Project, fields: Partial<typeof CONFIG>) => {
    project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, ...fields }));
  };

  // A translator's save of "Hello" in `po` (relative to the root), as its editor writes it.
  const translate = (project: Project, po: string) => {
    project.write(po, project.read(po).replace(`msgid "Hello"\nmsgstr ""`, `msgid "Hello"\nmsgstr "Hei"`));
  };

  // A change's native event, as `fs.watch` names it (macOS, Node 24, probed for each layout below): every open tree
  // whose directory, as the kernel resolves it, holds the file (directly, for a tree watched as one directory) gets the
  // file's name relative to that directory, whatever the tree's spelling. A tree spelled through a link or in another
  // case is watched where the kernel takes it, and so is one spelled with `..` (`messages/jump/..` watches `other`). The
  // file's directory is resolved, so a deleted file is delivered too. `event` is `change` for a write in place, and
  // `rename` for a file that appeared or went away (a delete, or an atomic save's rename over the file).
  const deliver = (events: DeliveredEvents, file: string, event: ChangeEvent = "change") => {
    const real = join(realpathSync.native(dirname(file)), basename(file));

    for (const tree of events.open()) {
      const directory = realpathSync.native(tree);
      const holds = events.recursive(tree)
        ? real.startsWith(`${directory}${sep}`)
        : dirname(real) === directory;

      if (holds) {
        events.listener(tree).change(event, relative(directory, real));
      }
    }
  };

  // Each layout: the config and links it sets up, the PO a translator saves (relative to the root), and whether that
  // PO is a configured catalog, so the save must sync.
  const LAYOUTS = [
    {
      // (a) The issue's case: `..` before `{locale}` in an absolute pattern climbs out of `jump`'s target.
      name: "(a) absolute .. through a link",
      setup: (project: Project) => {
        configure(project, { catalogs: `${project.root}/messages/jump/../{locale}.po` });
        mkdirSync(project.path("messages"));
        mkdirSync(project.path("other/sub"), { recursive: true });
        symlinkSync("../other/sub", project.path("messages/jump"));
      },
      saved: "other/nb.po",
      syncs: true,
    },
    {
      // (a) The same climb into a directory the config excludes, inside an include root: a poll walks it only
      // because it holds a catalog.
      name: "(a) absolute .. into an excluded directory",
      setup: (project: Project) => {
        project.write(
          "elmera-intl.json",
          JSON.stringify({
            ...CONFIG,
            exclude: ["src/locales/**"],
            catalogs: `${project.root}/messages/jump/../{locale}.po`,
          })
        );
        mkdirSync(project.path("messages"));
        mkdirSync(project.path("src/locales/sub"), { recursive: true });
        symlinkSync("../src/locales/sub", project.path("messages/jump"));
      },
      saved: "src/locales/nb.po",
      syncs: true,
    },
    {
      // (b) The catalogs' directory is a link elsewhere.
      name: "(b) a linked catalogs directory",
      setup: (project: Project) => {
        mkdirSync(project.path("elsewhere/messages"), { recursive: true });
        symlinkSync(project.path("elsewhere/messages"), project.path("messages"));
      },
      saved: "elsewhere/messages/nb.po",
      syncs: true,
    },
    {
      // A catalog that is a file link to a file outside the watched trees, which `extract` writes through the link: a
      // save to the target raises its event only in the target's directory.
      name: "a catalog linked to a file elsewhere",
      setup: (project: Project) => {
        project.write("translations/canonical-nb.po", "");
        mkdirSync(project.path("messages"));
        symlinkSync("../translations/canonical-nb.po", project.path("messages/nb.po"));
      },
      saved: "translations/canonical-nb.po",
      syncs: true,
    },
    {
      // (d) A relative pattern is joined onto the root, which collapses its `..` (`messages/nb.po`, README): that is
      // where `extract` writes, not `other/nb.po`, where the kernel would take `jump/..`.
      name: "(d) relative .. through a link",
      setup: (project: Project) => {
        configure(project, { catalogs: "messages/jump/../{locale}.po" });
        mkdirSync(project.path("messages"));
        mkdirSync(project.path("other/sub"), { recursive: true });
        symlinkSync("../other/sub", project.path("messages/jump"));
      },
      saved: "messages/nb.po",
      syncs: true,
    },
    {
      // (e) A PO beside the catalogs that no locale's catalog is.
      name: "(e) a PO beside the catalogs",
      setup: (project: Project) => {
        project.write("messages/xx.po", `msgid "Hello"\nmsgstr ""\n`);
      },
      saved: "messages/xx.po",
      syncs: false,
    },
    {
      // (e) The same beside a catalog an absolute pattern reaches with `..`.
      name: "(e) a PO beside a climbing catalog",
      setup: (project: Project) => {
        configure(project, { catalogs: `${project.root}/messages/jump/../{locale}.po` });
        mkdirSync(project.path("messages"));
        mkdirSync(project.path("other/sub"), { recursive: true });
        symlinkSync("../other/sub", project.path("messages/jump"));
        project.write("other/xx.po", `msgid "Hello"\nmsgstr ""\n`);
      },
      saved: "other/xx.po",
      syncs: false,
    },
  ] as const;

  it.effect.each(LAYOUTS.flatMap((layout) => MODES.map((mode) => ({ ...layout, ...mode }))))(
    "$name, on $mode",
    ({ setup, saved, syncs, watchMode }, { project }) =>
      Effect.gen(function* () {
        setup(project);
        const events = deliveredEvents();
        const { reports } = yield* startWatch(project, { mode: watchMode, events: events.layer });
        const started = [...reports];
        translate(project, saved);

        if (watchMode._tag === "native") {
          deliver(events, project.path(saved));
        }

        yield* TestClock.adjust("1 second");

        expect({ started, after: reports.slice(started.length) }).toEqual({
          started: ["Written"],
          after: syncs ? ["Unchanged"] : [],
        });
      })
  );

  // (c) A pattern spelled in another case than the disk, on a volume that folds case: `extract` writes the file the
  // spelling reaches, and the translator saves it under its own name. A directory in another case
  // (`Messages/{locale}.po` for `messages/nb.po`) is watched as spelled, so its changes name the catalog as spelled; a
  // file name in another case (`messages/Cat-{locale}.po` for `messages/cat-nb.po`) is named by the change as on disk.
  // Skipped on a case-sensitive volume (Linux CI), where no other spelling reaches the catalog.
  describe.skipIf(!FOLDS_CASE)("on a volume that folds case", () => {
    it.effect.each(
      [
        {
          spelling: "directory",
          catalogs: "Messages/{locale}.po",
          setup: (project: Project) => {
            mkdirSync(project.path("messages"));
          },
          saved: "messages/nb.po",
        },
        {
          spelling: "file name",
          catalogs: "messages/Cat-{locale}.po",
          setup: (project: Project) => {
            project.write("messages/cat-nb.po", "");
          },
          saved: "messages/cat-nb.po",
        },
      ].flatMap((layout) => MODES.map((mode) => ({ ...layout, ...mode })))
    )(
      "(c) a $spelling in another case than the disk, on $mode",
      ({ catalogs, setup, saved, watchMode }, { project }) =>
        Effect.gen(function* () {
          configure(project, { catalogs });
          setup(project);
          const events = deliveredEvents();
          const { reports } = yield* startWatch(project, { mode: watchMode, events: events.layer });
          const started = [...reports];
          translate(project, saved);

          if (watchMode._tag === "native") {
            deliver(events, project.path(saved));
          }

          yield* TestClock.adjust("1 second");

          expect({ started, after: reports.slice(started.length) }).toEqual({
            started: ["Written"],
            after: ["Unchanged"],
          });
        })
    );
  });

  // (a) A deleted catalog is still the catalog it was: its identity is resolved through its directory. The sync it
  // runs writes the catalog again, and nothing else ran before the delete.
  it.effect.each(MODES)(
    "(a) a deleted catalog an absolute .. reaches, on $mode",
    ({ watchMode }, { project }) =>
      Effect.gen(function* () {
        configure(project, { catalogs: `${project.root}/messages/jump/../{locale}.po` });
        mkdirSync(project.path("messages"));
        mkdirSync(project.path("other/sub"), { recursive: true });
        symlinkSync("../other/sub", project.path("messages/jump"));
        const events = deliveredEvents();
        const { reports } = yield* startWatch(project, { mode: watchMode, events: events.layer });
        // A walk after the first sync, so the poll has seen the catalog that sync created before it goes.
        yield* TestClock.adjust("1 second");
        const started = [...reports];
        rmSync(project.path("other/nb.po"));

        if (watchMode._tag === "native") {
          deliver(events, project.path("other/nb.po"), "rename");
        }

        yield* TestClock.adjust("1 second");

        expect({ started, after: reports.slice(started.length) }).toEqual({
          started: ["Written"],
          after: ["Written"],
        });
        expect(project.read("other/nb.po")).toContain(`msgid "Hello"`);
      })
  );

  // The issue's other case: an absolute pattern whose `..` follows a directory that does not exist yet reaches no
  // file, so the first sync fails (`CatalogClimbsMissing`). Once the directory is created, a source's change syncs,
  // which writes the catalog, and from then on a save to it is a save to a catalog: the watch resolves the catalogs
  // again after each sync, not once as it starts.
  it.effect.each(MODES)(
    "a catalog whose .. climbs out of a directory created after the start, on $mode",
    ({ watchMode }, { project }) =>
      Effect.gen(function* () {
        configure(project, { catalogs: `${project.root}/messages/missing/../{locale}.po` });
        mkdirSync(project.path("messages"));
        const events = deliveredEvents();
        const { reports } = yield* startWatch(project, { mode: watchMode, events: events.layer });
        const started = [...reports];
        mkdirSync(project.path("messages/missing"));
        project.write("src/ready.tsx", component("Ready"));

        if (watchMode._tag === "native") {
          deliver(events, project.path("src/ready.tsx"));
        }

        yield* TestClock.adjust("1 second");
        const created = reports.slice(started.length);
        translate(project, "messages/nb.po");

        if (watchMode._tag === "native") {
          deliver(events, project.path("messages/nb.po"));
        }

        yield* TestClock.adjust("1 second");

        expect({ started, created, saved: reports.slice(started.length + created.length) }).toEqual({
          started: ["Failed"],
          created: ["Written"],
          saved: ["Unchanged"],
        });
      })
  );

  // A source tree under a link, inside the directory a climbing catalog lands in: a recursive native watch of that
  // directory does not follow the link, so the linked tree is watched on its own. Oracle: the contract by hand: the
  // save to the linked source syncs, and the catalog then holds its message.
  it.effect.each(MODES)(
    "a save to a linked source inside a climbing catalog's directory, on $mode",
    ({ watchMode }, { project }) =>
      Effect.gen(function* () {
        configure(project, {
          include: ["src/linked/*.tsx"],
          catalogs: `${project.root}/messages/jump/../{locale}.po`,
        });
        mkdirSync(project.path("messages"));
        mkdirSync(project.path("src/sub"), { recursive: true });
        symlinkSync("../src/sub", project.path("messages/jump"));
        project.write("feature/page.tsx", component("Hello"));
        symlinkSync("../feature", project.path("src/linked"));
        const events = deliveredEvents();
        const { reports } = yield* startWatch(project, { mode: watchMode, events: events.layer });
        const started = [...reports];
        project.write("src/linked/page.tsx", component("Saved"));

        if (watchMode._tag === "native") {
          deliver(events, project.path("src/linked/page.tsx"));
        }

        yield* TestClock.adjust("1 second");

        expect({
          started,
          after: reports.slice(started.length),
          saved: project.read("src/nb.po").includes(`msgid "Saved"`),
        }).toEqual({ started: ["Written"], after: ["Written"], saved: true });
      })
  );

  // An editor's atomic save over a catalog's file link, at the file the climb lands on: a new file renamed over the
  // link. The catalog is then that regular file, which the last sync's identities do not name (they followed the link),
  // and a save to it is a save to the catalog. The file it renames in lacks the catalog's entry, so the sync this runs
  // restores it.
  it.effect.each(MODES)(
    "an atomic save over a climbing catalog's file link, on $mode",
    ({ watchMode }, { project }) =>
      Effect.gen(function* () {
        configure(project, { catalogs: `${project.root}/app/messages/jump/../{locale}.po` });
        mkdirSync(project.path("app/messages"), { recursive: true });
        mkdirSync(project.path("app/shared/sub"), { recursive: true });
        symlinkSync("../shared/sub", project.path("app/messages/jump"));
        project.write("translations/nb.po", "");
        symlinkSync("../../translations/nb.po", project.path("app/shared/nb.po"));
        const events = deliveredEvents();
        const { reports } = yield* startWatch(project, { mode: watchMode, events: events.layer });
        yield* TestClock.adjust("1 second");
        const started = [...reports];
        project.write("app/shared/nb.po.tmp", "");
        renameSync(project.path("app/shared/nb.po.tmp"), project.path("app/shared/nb.po"));

        if (watchMode._tag === "native") {
          deliver(events, project.path("app/shared/nb.po"), "rename");
        }

        yield* TestClock.adjust("1 second");

        expect({
          started,
          after: reports.slice(started.length),
          restored: project.read("app/shared/nb.po").includes(`msgid "Hello"`),
        }).toEqual({ started: ["Written"], after: ["Written"], restored: true });
      })
  );

  // A catalog that is a file link (`messages/nb.po -> ../translations/canonical-nb.po`) is watched beside its target
  // for native events only, and only that directory's own entries: a poll reads the target through the link, so it
  // never walks the target's directory, and a native watch of it never opens a directory under it.
  const linkedCatalog = (project: Project) => {
    project.write("translations/canonical-nb.po", "");
    mkdirSync(project.path("messages"));
    symlinkSync("../translations/canonical-nb.po", project.path("messages/nb.po"));
  };

  // Polling never walks the target's directory, so a directory there it cannot read leaves nothing unwatched and is
  // no problem, while a save to the target still syncs through the link. Skipped as root, which reads any directory.
  it.effect.skipIf(process.getuid?.() === 0)(
    "an unreadable directory beside a linked catalog's target, on polling",
    ({ project }) =>
      Effect.gen(function* () {
        linkedCatalog(project);
        project.lock("translations/private");
        const { reports } = yield* startWatch(project, { mode: POLLING });
        const started = [...reports];
        translate(project, "translations/canonical-nb.po");
        yield* TestClock.adjust("1 second");

        expect({ started, after: reports.slice(started.length) }).toEqual({
          started: ["Written"],
          after: ["Unchanged"],
        });
      })
  );

  // The native watch beside the target is best-effort: when its directory cannot be watched (it allows opening the
  // catalog by name but denies listing), the watch starts and runs on the trees it had before, so a source's save
  // still syncs.
  it.effect("a linked catalog's target directory that cannot be watched, on native events", ({ project }) =>
    Effect.gen(function* () {
      linkedCatalog(project);
      const events = deliveredEvents({
        refuses: { dir: project.path("translations"), error: new Error("EACCES: permission denied, watch") },
      });
      const { reports } = yield* startWatch(project, { mode: NATIVE, events: events.layer });
      const started = [...reports];
      project.write("src/ready.tsx", component("Ready"));
      deliver(events, project.path("src/ready.tsx"));
      yield* TestClock.adjust("1 second");

      expect({ started, after: reports.slice(started.length), open: events.open() }).toEqual({
        started: ["Written"],
        after: ["Written"],
        open: [project.path("messages"), project.path("src")],
      });
    })
  );

  // The native watch beside a linked catalog's target is of that directory alone, never of the directories under it.
  it.effect("watches a linked catalog's target directory alone, on native events", ({ project }) =>
    Effect.gen(function* () {
      linkedCatalog(project);
      const events = deliveredEvents();
      yield* startWatch(project, { mode: NATIVE, events: events.layer });

      expect(
        events
          .open()
          .map((tree) => ({ tree: relative(project.root, tree), recursive: events.recursive(tree) }))
      ).toEqual([
        { tree: "messages", recursive: true },
        { tree: "src", recursive: true },
        { tree: "translations", recursive: false },
      ]);
    })
  );

  // (e) A PO in a watched tree named as a catalog is (`nb.po`) but another file: the name passes the prefilter, and the
  // identity tells it apart. After a sync that failed there is no record, so a change taken for the catalog would run a
  // sync, and the guard shows as an extra result.
  it.effect.each(MODES)(
    "(e) a PO named as a catalog in another directory, after a failed sync, on $mode",
    ({ watchMode }, { project }) =>
      Effect.gen(function* () {
        project.write("messages/old/nb.po", `msgid "Hello"\nmsgstr ""\n`);
        const events = deliveredEvents();
        const { reports } = yield* startWatch(project, { mode: watchMode, events: events.layer });
        project.write("messages/nb.po", 'msgid "unterminated\n');

        if (watchMode._tag === "native") {
          deliver(events, project.path("messages/nb.po"));
        }

        yield* TestClock.adjust("1 second");
        const failed = [...reports];
        translate(project, "messages/old/nb.po");

        if (watchMode._tag === "native") {
          deliver(events, project.path("messages/old/nb.po"));
        }

        yield* TestClock.adjust("1 second");

        expect({ failed, after: reports.slice(failed.length) }).toEqual({
          failed: ["Written", "Failed"],
          after: [],
        });
      })
  );

  // (d) Where `extract` writes a relative pattern with `..` through a link: at the lexical path, as the watch reads it.
  it.effect(
    "writes a relative pattern's catalog where its .. collapses, not where the kernel climbs",
    ({ project }) =>
      Effect.gen(function* () {
        configure(project, { catalogs: "messages/jump/../{locale}.po" });
        mkdirSync(project.path("messages"));
        mkdirSync(project.path("other/sub"), { recursive: true });
        symlinkSync("../other/sub", project.path("messages/jump"));
        yield* startWatch(project);

        expect({
          lexical: existsSync(project.path("messages/nb.po")),
          kernel: existsSync(project.path("other/nb.po")),
        }).toEqual({ lexical: true, kernel: false });
      })
  );
});
