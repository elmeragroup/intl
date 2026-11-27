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

// A translator's save to a catalog, however the config spells the catalog's path (#89), where the watch's trees already
// deliver the save: the questions are what the tree names the saved file (a tree spelled with `..` lists, and names
// relative to, the directory the kernel climbs to) and whether that file is a configured catalog. Unit under test:
// `watchCatalogs` with the real `CatalogSync`, on the test clock, its catalogs on Node's files, in both modes: polling,
// whose walks read the real trees, and native events, which the test delivers as `fs.watch` names them. Oracle: the
// contract by hand: a save to a configured locale's catalog, wherever `extract` writes it, runs one sync, which finds
// the catalog's translation already merged (`Unchanged`); a save to a PO that is no configured catalog runs none.
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

  // A change's native event, as `fs.watch` names it (macOS, Node 24): every open tree whose directory, as the kernel
  // resolves it, holds the file gets the file's name relative to that directory, whatever the tree's spelling. A tree
  // spelled with `..` is watched where the kernel takes it (`messages/jump/..` watches `jump`'s target's parent). The
  // file's directory is resolved, so a deleted file is delivered too. `event` is `change` for a write in place, and
  // `rename` for a file that appeared or went away (a delete, or an atomic save's rename over the file).
  const deliver = (events: DeliveredEvents, file: string, event: ChangeEvent = "change") => {
    const real = join(realpathSync.native(dirname(file)), basename(file));

    for (const tree of events.open()) {
      const directory = realpathSync.native(tree);

      if (real.startsWith(`${directory}${sep}`)) {
        events.listener(tree).change(event, relative(directory, real));
      }
    }
  };

  // The issue's case, with the climb landing inside an include root, which the watch walks: an absolute pattern's `..`
  // before `{locale}` climbs out of `jump`'s target, `src/i18n/sub`, so `extract` writes `src/i18n/nb.po`.
  const climbIntoSource = (project: Project) => {
    configure(project, { catalogs: `${project.root}/messages/jump/../{locale}.po` });
    mkdirSync(project.path("messages"));
    mkdirSync(project.path("src/i18n/sub"), { recursive: true });
    symlinkSync("../src/i18n/sub", project.path("messages/jump"));
  };

  // The issue's own case: the climb lands outside the include roots, so only the tree the watch opens at the catalog's
  // directory as spelled, `messages/jump/..`, delivers the save. The kernel watches where that climbs to, `jump`'s
  // target's parent `translations`, and names the change relative to it, so the change is that tree's real path joined
  // with the name; `extract` writes `translations/nb.po`.
  const climbThroughLink = (project: Project) => {
    configure(project, { catalogs: `${project.root}/messages/jump/../{locale}.po` });
    mkdirSync(project.path("messages"));
    mkdirSync(project.path("translations/sub"), { recursive: true });
    symlinkSync("../translations/sub", project.path("messages/jump"));
  };

  // A climb outside the include roots that lands where it starts: `messages/sub/..` is `messages`, so `extract` writes
  // `messages/nb.po`, which the config spells `messages/sub/../nb.po`.
  const climbInPlace = (project: Project) => {
    configure(project, { catalogs: `${project.root}/messages/sub/../{locale}.po` });
    mkdirSync(project.path("messages/sub"), { recursive: true });
  };

  // The climbs outside the include roots, each with the directory its catalog lands in (relative to the root), in both
  // modes. A deletion or a rename under an include root may move a tree and syncs whatever its file, so a catalog's own
  // deletion or rename is shown in these.
  const CLIMBS = [
    { climb: "in place", setup: climbInPlace, landed: "messages" },
    { climb: "through a link", setup: climbThroughLink, landed: "translations" },
  ].flatMap((climb) => MODES.map((mode) => ({ ...climb, ...mode })));

  // Each layout: the config and links it sets up, the PO a translator saves (relative to the root), a configured
  // catalog, so the save must sync, and the modes whose trees deliver the save.
  const LAYOUTS = [
    {
      name: "(a) absolute .. through a link",
      setup: climbThroughLink,
      saved: "translations/nb.po",
      modes: MODES,
    },
    {
      name: "(a) absolute .. through a link into an include root",
      setup: climbIntoSource,
      saved: "src/i18n/nb.po",
      modes: MODES,
    },
    {
      // The same climb into a directory the config excludes: a native watch of the include root delivers its save,
      // and so does the tree opened at the catalog's directory as spelled, which a poll walks from its real path while
      // its walk of the include root prunes the directory.
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
      modes: MODES,
    },
    {
      // An absolute pattern with a `.` segment and a doubled separator, which name its directory as it is.
      name: "an absolute pattern with ./ and a doubled separator",
      setup: (project: Project) => {
        configure(project, { catalogs: `${project.root}/src/./i18n//{locale}.po` });
        mkdirSync(project.path("src/i18n"), { recursive: true });
      },
      saved: "src/i18n/nb.po",
      modes: MODES,
    },
  ] as const;

  it.effect.each(LAYOUTS.flatMap(({ modes, ...layout }) => modes.map((mode) => ({ ...layout, ...mode }))))(
    "$name, on $mode",
    ({ setup, saved, watchMode }, { project }) =>
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
          after: ["Unchanged"],
        });
      })
  );

  // (c) A file name spelled in another case than the disk (`messages/Cat-{locale}.po` for `messages/cat-nb.po`), on a
  // volume that folds case: `extract` writes the file the spelling reaches, and the change names it as on disk.
  // Skipped on a case-sensitive volume (Linux CI), where no other spelling reaches the catalog.
  describe.skipIf(!FOLDS_CASE)("on a volume that folds case", () => {
    it.effect.each(MODES)(
      "(c) a file name in another case than the disk, on $mode",
      ({ watchMode }, { project }) =>
        Effect.gen(function* () {
          configure(project, { catalogs: "messages/Cat-{locale}.po" });
          project.write("messages/cat-nb.po", "");
          const events = deliveredEvents();
          const { reports } = yield* startWatch(project, { mode: watchMode, events: events.layer });
          const started = [...reports];
          translate(project, "messages/cat-nb.po");

          if (watchMode._tag === "native") {
            deliver(events, project.path("messages/cat-nb.po"));
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
  it.effect.each(CLIMBS)(
    "(a) a deleted catalog an absolute .. reaches $climb, on $mode",
    ({ setup, landed, watchMode }, { project }) =>
      Effect.gen(function* () {
        setup(project);
        const events = deliveredEvents();
        const { reports } = yield* startWatch(project, { mode: watchMode, events: events.layer });
        // A walk after the first sync, so the poll has seen the catalog that sync created before it goes.
        yield* TestClock.adjust("1 second");
        const started = [...reports];
        rmSync(project.path(`${landed}/nb.po`));

        if (watchMode._tag === "native") {
          deliver(events, project.path(`${landed}/nb.po`), "rename");
        }

        yield* TestClock.adjust("1 second");

        expect({ started, after: reports.slice(started.length) }).toEqual({
          started: ["Written"],
          after: ["Written"],
        });
        expect(project.read(`${landed}/nb.po`)).toContain(`msgid "Hello"`);
      })
  );

  // The issue's other case: an absolute pattern whose `..` follows a directory that does not exist yet reaches no
  // file, so the first sync fails (`CatalogClimbsMissing`). Once the directory is created, a source's change syncs,
  // which writes the catalog, and from then on a save to it is a save to a catalog: the catalog's identity is the one it
  // has now, not the none it had as the watch started.
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

  // An editor's atomic save over a catalog's file link, at the file the climb lands on: a new file renamed over the
  // link. The catalog is then that regular file, which the last sync's identities do not name (they followed the link),
  // and a save to it is a save to the catalog. The file it renames in lacks the catalog's entry, so the sync this runs
  // restores it.
  it.effect.each(CLIMBS)(
    "an atomic save over the file link an absolute .. reaches $climb, on $mode",
    ({ setup, landed, watchMode }, { project }) =>
      Effect.gen(function* () {
        setup(project);
        project.write("shared/nb.po", "");
        symlinkSync("../shared/nb.po", project.path(`${landed}/nb.po`));
        const events = deliveredEvents();
        const { reports } = yield* startWatch(project, { mode: watchMode, events: events.layer });
        yield* TestClock.adjust("1 second");
        const started = [...reports];
        project.write(`${landed}/nb.po.tmp`, "");
        renameSync(project.path(`${landed}/nb.po.tmp`), project.path(`${landed}/nb.po`));

        if (watchMode._tag === "native") {
          deliver(events, project.path(`${landed}/nb.po`), "rename");
        }

        yield* TestClock.adjust("1 second");

        expect({
          started,
          after: reports.slice(started.length),
          restored: project.read(`${landed}/nb.po`).includes(`msgid "Hello"`),
        }).toEqual({ started: ["Written"], after: ["Written"], restored: true });
      })
  );

  // (e) A PO beside a catalog that no locale's catalog is, after a sync that failed: then there is no record, so a change
  // taken for the catalog would run a sync, and the guard shows as an extra result. The sync fails on the catalog itself,
  // written unparseable; `saved` is the PO beside it.
  const BESIDE = [
    {
      name: "(e) a PO beside the catalogs",
      setup: () => undefined,
      catalog: "messages/nb.po",
      saved: "messages/xx.po",
    },
    {
      // The same beside a catalog an absolute pattern reaches with `..`.
      name: "(e) a PO beside a climbing catalog",
      setup: climbIntoSource,
      catalog: "src/i18n/nb.po",
      saved: "src/i18n/xx.po",
    },
  ] as const;

  it.effect.each(BESIDE.flatMap((guard) => MODES.map((mode) => ({ ...guard, ...mode }))))(
    "$name, after a failed sync, on $mode",
    ({ setup, catalog, saved, watchMode }, { project }) =>
      Effect.gen(function* () {
        setup(project);
        project.write(saved, `msgid "Hello"\nmsgstr ""\n`);
        const events = deliveredEvents();
        const { reports } = yield* startWatch(project, { mode: watchMode, events: events.layer });
        project.write(catalog, 'msgid "unterminated\n');

        if (watchMode._tag === "native") {
          deliver(events, project.path(catalog));
        }

        yield* TestClock.adjust("1 second");
        const failed = [...reports];
        translate(project, saved);

        if (watchMode._tag === "native") {
          deliver(events, project.path(saved));
        }

        yield* TestClock.adjust("1 second");

        expect({ failed, after: reports.slice(failed.length) }).toEqual({
          failed: ["Written", "Failed"],
          after: [],
        });
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

  // (e) The file a catalog was before its directory's link was repointed is no longer the catalog: the sync after the
  // repoint resolves the catalogs again, so a save to the old file is a save to a PO that is no catalog. That sync
  // fails, so there is no record, and a change taken for the catalog would run a sync, which shows as an extra result.
  it.effect.each(MODES)(
    "(e) the file a repointed catalog link left, after a failed sync, on $mode",
    ({ watchMode }, { project }) =>
      Effect.gen(function* () {
        mkdirSync(project.path("src/old"), { recursive: true });
        mkdirSync(project.path("src/new"));
        symlinkSync("src/old", project.path("messages"));
        const events = deliveredEvents();
        const { reports } = yield* startWatch(project, { mode: watchMode, events: events.layer });
        rmSync(project.path("messages"));
        symlinkSync("src/new", project.path("messages"));
        project.write("src/new/nb.po", 'msgid "unterminated\n');

        if (watchMode._tag === "native") {
          deliver(events, project.path("src/new/nb.po"));
        }

        yield* TestClock.adjust("1 second");
        const failed = [...reports];
        translate(project, "src/old/nb.po");

        if (watchMode._tag === "native") {
          deliver(events, project.path("src/old/nb.po"));
        }

        yield* TestClock.adjust("1 second");

        expect({ failed, after: reports.slice(failed.length) }).toEqual({
          failed: ["Written", "Failed"],
          after: [],
        });
      })
  );
});
