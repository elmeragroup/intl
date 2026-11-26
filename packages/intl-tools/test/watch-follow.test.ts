import { describe, expect } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { existsSync, renameSync, rmSync, symlinkSync, utimesSync } from "node:fs";

import { CliPlatform, cliProgram } from "../src/cli-run";
import type { ProjectConfig } from "../src/project-config";
import { Reporter } from "../src/reporter";
import type { FileEvents } from "../src/watch-trees";
import type { Project } from "./project-fixture";
import { syncFileSystem } from "./sync-file-system";
import {
  afterRead,
  catalog,
  claimSensitive,
  CONFIG_READ,
  CONFIG_TEXT,
  ending,
  FI_TEXT,
  gates,
  holding,
  NATIVE,
  nextRead,
  SV_TEXT,
  twoTrees,
} from "./watch-follow-project";
import {
  component,
  deliveredEvents,
  it,
  launchFollow,
  POLL_MS,
  startFollow,
  syncCatalogServices,
  wake,
  woken,
} from "./watch-project";

// The executable's watch in this process on the test clock, its output collected: its services are built
// synchronously and read through the synchronous file system, so each step it takes completes within the clock's move.
const runWatch = Effect.fnUntraced(function* (
  project: Project,
  flags: ReadonlyArray<string>,
  events: Layer.Layer<FileEvents>
) {
  let stdout = "";
  const reporter = Reporter.layer({
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stdout += text;
    },
  });
  yield* wake(
    cliProgram(["extract", "--watch", ...flags], { cwd: project.root }).pipe(
      Effect.provide([CliPlatform, reporter, syncCatalogServices(), events])
    )
  );

  return () => stdout;
});

// Unit under test: `elmera-intl extract --watch` across an edit of its `elmera-intl.json` (#73), on native file events
// and on polling. Oracle: the config contract, by hand: a watch syncs one catalog per configured locale, its start
// included, so once the watch has read the edit adding `sv`, it has written `messages/sv.po` with the project's message
// and said so.
describe("extract --watch follows its config", () => {
  it.effect.each([
    { mode: "native file events", flags: [], read: Duration.millis(250) },
    { mode: "polling", flags: ["--poll", POLL_MS], read: Duration.millis(Number(POLL_MS)) },
  ])("restarts on an edit of its config, on $mode", ({ flags, read }, { project }) =>
    Effect.gen(function* () {
      const output = yield* runWatch(project, flags, deliveredEvents().layer);
      yield* TestClock.adjust("1 millis");
      expect(output()).toContain("watching");

      project.write("elmera-intl.json", SV_TEXT);
      yield* afterRead(read);

      expect([catalog(project, "sv"), output()]).toEqual([
        expect.stringContaining(`msgid "Hello"`),
        expect.stringContaining("elmera-intl.json changed, restarting the watch\nwrote messages/sv.po\n"),
      ]);
    })
  );
});

// Unit under test: `followConfig`, the watch that follows its config, on the test clock, polling every 50 ms (its
// reads of the config ride the poll's interval). Oracle: the config contract, by hand: the watch running is always on
// the config as last read, one catalog per configured locale synced at its start, so after an edit the edited config's
// catalogs hold the project's message, and a config read as before restarts nothing.
describe("followConfig", () => {
  // Each row: the follow handed its first read of the config, as the CLI hands it, or reading it itself.
  it.effect.each(["handed" as const, "own" as const])(
    "restarts on the config's edits only when its text changes (%s first read)",
    (first, { project }) =>
      Effect.gen(function* () {
        const { reports } = yield* startFollow(project, { first });
        project.write("elmera-intl.json", CONFIG_TEXT);
        yield* nextRead;
        expect(reports).toEqual(["Written"]);

        project.write("elmera-intl.json", SV_TEXT);
        yield* nextRead;
        expect([reports, catalog(project, "sv")]).toEqual([
          ["Written", "ConfigChanged", "Written", "Restarted"],
          expect.stringContaining(`msgid "Hello"`),
        ]);
      }).pipe(claimSensitive)
  );

  // Each row: how an editor, a deploy or a branch switch changes the config. A read follows the path whatever it is,
  // so every shape is one more text.
  it.effect.each([
    {
      saved: "an atomic replace",
      setup: () => undefined,
      change: (project: Project) => {
        project.write("elmera-intl.json.tmp", SV_TEXT);
        renameSync(project.path("elmera-intl.json.tmp"), project.path("elmera-intl.json"));
      },
    },
    {
      saved: "a link repointed",
      setup: (project: Project) => {
        project.write("configs/nb.json", CONFIG_TEXT);
        project.write("configs/sv.json", SV_TEXT);
        rmSync(project.path("elmera-intl.json"));
        symlinkSync(project.path("configs/nb.json"), project.path("elmera-intl.json"));
      },
      change: (project: Project) => {
        rmSync(project.path("elmera-intl.json"));
        symlinkSync(project.path("configs/sv.json"), project.path("elmera-intl.json"));
      },
    },
    {
      saved: "a dangling link's target restored",
      setup: (project: Project) => {
        project.write("shared/elmera-intl.json", CONFIG_TEXT);
        rmSync(project.path("elmera-intl.json"));
        symlinkSync(project.path("shared/elmera-intl.json"), project.path("elmera-intl.json"));
        rmSync(project.path("shared/elmera-intl.json"));
      },
      change: (project: Project) => {
        project.write("shared/elmera-intl.json", SV_TEXT);
      },
    },
    {
      saved: "a link repointed to a same-size older file",
      setup: (project: Project) => {
        project.write("configs/fi.json", FI_TEXT);
        project.write("configs/sv.json", SV_TEXT);
        utimesSync(project.path("configs/sv.json"), 1, 1);
        rmSync(project.path("elmera-intl.json"));
        symlinkSync(project.path("configs/fi.json"), project.path("elmera-intl.json"));
      },
      change: (project: Project) => {
        rmSync(project.path("elmera-intl.json"));
        symlinkSync(project.path("configs/sv.json"), project.path("elmera-intl.json"));
      },
    },
  ])("follows $saved of its config", ({ setup, change }, { project }) =>
    Effect.gen(function* () {
      setup(project);
      yield* startFollow(project);
      change(project);
      yield* nextRead;

      expect(catalog(project, "sv")).toContain(`msgid "Hello"`);
    })
  );

  // An edit that breaks the config stops the watch and reports the problem; nothing syncs until the next edit, whose
  // valid config starts a watch again.
  it.effect("stops on an invalid config, and starts again once it is fixed", ({ project }) =>
    Effect.gen(function* () {
      const events = deliveredEvents();
      const { reports, results } = yield* startFollow(project, { mode: NATIVE, events: events.layer });
      project.write("elmera-intl.json", "{");
      yield* afterRead(CONFIG_READ);
      expect([reports, events.open()]).toEqual([["Written", "ConfigChanged", "Failed"], []]);
      expect(results[2]).toMatchObject({ problems: [{ code: "ConfigInvalid" }] });

      project.write("elmera-intl.json", SV_TEXT);
      yield* afterRead(CONFIG_READ);
      expect(catalog(project, "sv")).toContain(`msgid "Hello"`);
    })
  );

  // A follow that starts on a missing config (a dev server's, its `config/` directory not made yet) reports it, has
  // started, and starts a watch once the config is written.
  it.effect.each(["handed" as const, "own" as const])(
    "starts on a missing config, and starts a watch once it is written (%s first read)",
    (first, { project }) =>
      Effect.gen(function* () {
        const { reports, watching } = yield* startFollow(project, {
          first,
          config: "config/elmera-intl.json",
        });
        expect([watching._tag, reports]).toEqual(["Ready", ["Failed"]]);

        project.write("config/src/page.tsx", component("Hello"));
        project.write("config/elmera-intl.json", CONFIG_TEXT);
        yield* nextRead;

        expect(project.read("config/messages/nb.po")).toContain(`msgid "Hello"`);
      })
  );

  // The latest config wins: an edit made while a restart's watch is still syncing is read then, and the watch ends on
  // that config; then a save back to the first edit's text (A-B-A) is a change again.
  it.effect("ends on the config as last saved after edits during a restart", ({ project }) =>
    Effect.gen(function* () {
      const gate = yield* gates();
      const sync = holding((config) => (config.locales.includes("sv") ? gate.first : undefined));
      yield* startFollow(project, { layer: sync.layer });
      yield* gate.release;
      project.write("elmera-intl.json", SV_TEXT);
      yield* nextRead;
      expect(sync.held()).toBe(1);

      project.write("elmera-intl.json", FI_TEXT);
      yield* nextRead;
      yield* woken(Deferred.succeed(gate.first, undefined));
      yield* nextRead;
      expect(catalog(project, "fi")).toContain(`msgid "Hello"`);

      rmSync(project.path("messages/sv.po"));
      project.write("elmera-intl.json", SV_TEXT);
      yield* nextRead;
      expect(catalog(project, "sv")).toContain(`msgid "Hello"`);
    })
  );

  // Each row: a phase in which the follow cannot restart at once, its sync held. The edit is reported as it is read, not
  // once the phase ends, so a host drops what it compiled with the previous config at once; and once the hold ends,
  // the watch ends on the config as edited.
  it.effect.each([
    {
      phase: "the first start",
      holds: (config: ProjectConfig) => config.locales.length === 1,
      enter: (_project: Project) => Effect.void,
      whileHeld: ["ConfigChanged"],
    },
    {
      phase: "a drain of the running sync",
      holds: (config: ProjectConfig) => config.locales.length === 1,
      enter: Effect.fnUntraced(function* (project: Project) {
        project.write("src/new.tsx", component("New"));
        yield* TestClock.adjust("150 millis");
      }),
      whileHeld: ["Written", "ConfigChanged"],
    },
    {
      phase: "a restart's start",
      holds: (config: ProjectConfig) => config.locales.includes("sv"),
      enter: Effect.fnUntraced(function* (project: Project) {
        project.write("elmera-intl.json", SV_TEXT);
        yield* nextRead;
      }),
      whileHeld: ["Written", "ConfigChanged", "ConfigChanged"],
    },
  ])("reports an edit at once during $phase, and ends on it", ({ holds, enter, whileHeld }, { project }) =>
    Effect.gen(function* () {
      const gate = yield* gates();
      let armed = false;
      const sync = holding((config) => (armed && holds(config) ? gate.first : undefined));
      // The first start's row holds it from the first sync on; the others from their phase on.
      armed = whileHeld.length === 1;
      const { reports } = yield* launchFollow(project, { layer: sync.layer });
      yield* gate.release;
      yield* TestClock.adjust("1 millis");
      armed = true;
      yield* enter(project);
      project.write("elmera-intl.json", FI_TEXT);
      yield* nextRead;
      const reported = [...reports];
      armed = false;
      yield* woken(Deferred.succeed(gate.first, undefined));
      yield* nextRead;

      expect([sync.held(), reported, catalog(project, "fi")]).toEqual([
        1,
        whileHeld,
        expect.stringContaining(`msgid "Hello"`),
      ]);
    })
  );

  // The latest config wins by what was read last, not by comparing texts: a config saved away and back while the running
  // sync is held is two edits, each reported as read, and one restart, on the config as it was.
  it.effect(
    "reports two edits and restarts once when the config is saved away and back during a drain",
    ({ project }) =>
      Effect.gen(function* () {
        const gate = yield* gates();
        let armed = false;
        const sync = holding(() => (armed ? gate.first : undefined));
        const { reports } = yield* startFollow(project, { layer: sync.layer });
        yield* gate.release;
        armed = true;
        project.write("src/new.tsx", component("New"));
        yield* TestClock.adjust("150 millis");
        armed = false;
        project.write("elmera-intl.json", SV_TEXT);
        yield* nextRead;
        project.write("elmera-intl.json", CONFIG_TEXT);
        yield* nextRead;
        const whileHeld = [...reports];
        yield* woken(Deferred.succeed(gate.first, undefined));
        yield* nextRead;

        expect([whileHeld, reports, catalog(project, "sv")]).toEqual([
          ["Written", "ConfigChanged", "ConfigChanged"],
          ["Written", "ConfigChanged", "ConfigChanged", "Written", "Unchanged", "Restarted"],
          "(missing)",
        ]);
      })
  );

  // A restart's watch says when its first sync's result is written (`Restarted`), after any warning its trees gave
  // first (an unreadable directory, polling): it follows that sync's result, which can be a failure or a superseded sync,
  // and a later sync that reports what it wrote reports `Written` (one that writes some POs and then fails, `Failed`).
  it.effect("reports a restart after the new watch's first sync, past its warnings", ({ project }) =>
    Effect.gen(function* () {
      project.lock("src/locked");
      const { reports } = yield* startFollow(project);
      project.write("elmera-intl.json", SV_TEXT);
      yield* nextRead;

      expect(reports.slice(reports.indexOf("ConfigChanged"))).toEqual([
        "ConfigChanged",
        "Failed",
        "Written",
        "Restarted",
      ]);
    })
  );

  // A restart whose watch fails to start (its sources' tree refused as it opens) is reported, with a fix that works
  // (a save of the same text is no edit), and the next edit starts a watch again.
  it.effect("reports a restart whose watch fails to start, and follows the next edit", ({ project }) =>
    Effect.gen(function* () {
      let refusals = 0;
      const events = twoTrees(project, {
        opening: (dir) => {
          if (dir === project.path("src") && refusals === 0 && existsSync(project.path("messages/nb.po"))) {
            refusals += 1;

            return Promise.reject(new Error("EACCES: permission denied, watch"));
          }

          return undefined;
        },
      });
      const { reports, results } = yield* startFollow(project, { mode: NATIVE, events: events.layer });
      project.write("elmera-intl.json", SV_TEXT);
      yield* afterRead(CONFIG_READ);
      expect(reports.slice(1)).toEqual(["ConfigChanged", "Failed"]);
      const failed = results[2];
      expect(
        failed?._tag === "Failed"
          ? failed.problems.map(({ code, message, fix }) => [
              code,
              message.includes("did not start: EACCES"),
              fix.includes("restart"),
            ])
          : failed
      ).toEqual([["WatchFailed", true, true]]);

      project.write("elmera-intl.json", FI_TEXT);
      yield* afterRead(CONFIG_READ);
      expect(catalog(project, "fi")).toContain(`msgid "Hello"`);
    })
  );

  // A host stop while the first sync is held (the start still running) ends the reader's turn: no read of the config
  // starts from the stop on, so a read that would stall on a mount never begins to keep the process alive past the
  // drain. Oracle: the reader's contract, by hand: every read is raced against the follow's end, which the host's stop
  // completes, so the count of reads of the config the file system saw stays as it was at the stop.
  it.effect("starts no read of the config once the host stops during the first sync", ({ project }) =>
    Effect.gen(function* () {
      const gate = yield* gates();
      const sync = holding(() => gate.first);
      let reads = 0;
      const { stop } = yield* launchFollow(project, {
        layer: sync.layer,
        fileSystem: syncFileSystem(
          (read) => (path) =>
            Effect.suspend(() => {
              reads += path === project.path("elmera-intl.json") ? 1 : 0;

              return read(path);
            })
        ),
      });
      yield* gate.release;
      yield* Deferred.succeed(stop, undefined);
      const atStop = reads;
      yield* nextRead;

      expect([sync.held(), reads - atStop]).toEqual([1, 0]);
    })
  );

  // A stop while a restart's watch is starting (its first sync held) stops it, with one shutdown: the sync finishes,
  // nothing more starts, every watcher closes, and `done` ends cleanly.
  it.effect("stops at once during a restart's start", ({ project }) =>
    Effect.gen(function* () {
      const gate = yield* gates();
      const sync = holding((config) => (config.locales.includes("sv") ? gate.first : undefined));
      const events = deliveredEvents();
      const { stop, watching } = yield* startFollow(project, {
        mode: NATIVE,
        events: events.layer,
        layer: sync.layer,
      });
      yield* gate.release;
      project.write("elmera-intl.json", SV_TEXT);
      yield* afterRead(CONFIG_READ);
      expect(sync.held()).toBe(1);

      yield* Deferred.succeed(stop, undefined);
      project.write("elmera-intl.json", FI_TEXT);
      yield* afterRead(CONFIG_READ);
      expect(events.open()).toEqual([]);
      yield* woken(Deferred.succeed(gate.first, undefined));
      const ended = yield* wake(watching.done);
      yield* TestClock.adjust("1 millis");

      expect([ended.pollUnsafe(), catalog(project, "fi")]).toEqual([Exit.void, "(missing)"]);
    })
  );

  // A config change whose report fails for good, its SyncFailed's too, while a sync's result waits behind it to be
  // written: the follow ends with that failure, the waiting write released, and nothing hangs.
  it.effect(
    "ends with a config change's report that fails for good, a result queued behind it",
    ({ project }) =>
      Effect.gen(function* () {
        const gate = yield* gates();
        let armed = false;
        const sync = holding(() => (armed ? gate.first : undefined));
        const { watching } = yield* startFollow(project, {
          layer: sync.layer,
          report: (result) =>
            result._tag === "ConfigChanged"
              ? Deferred.await(gate.second).pipe(Effect.andThen(Effect.die(new Error("stdout gone"))))
              : result._tag === "Failed"
                ? Effect.die(new Error("stdout gone"))
                : Effect.void,
        });
        yield* gate.release;
        armed = true;
        project.write("src/new.tsx", component("New"));
        yield* TestClock.adjust("150 millis");
        armed = false;
        project.write("elmera-intl.json", SV_TEXT);
        yield* nextRead;
        yield* woken(Deferred.succeed(gate.first, undefined));
        yield* woken(Deferred.succeed(gate.second, undefined));
        const ended = yield* wake(ending(watching.done));
        yield* nextRead;

        expect(ended.pollUnsafe()).toEqual(Exit.succeed("Error: stdout gone"));
      })
  );

  // Nothing a restart starts outlives it: after many restarts the watch has as many trees open, and as many opened and
  // not closed, as after one. Oracle: the file events' own counts of the trees opened and closed. The first watch opens
  // the project's root, before any catalog exists; each restart opens the catalogs' directory and the sources'.
  it.effect("holds no more after many restarts than after one", ({ project }) =>
    Effect.gen(function* () {
      const events = deliveredEvents();
      yield* startFollow(project, { mode: NATIVE, events: events.layer });
      const held = () => [events.open().length, events.calls() - events.closes()];
      project.write("elmera-intl.json", SV_TEXT);
      yield* afterRead(CONFIG_READ);
      const afterOne = held();

      for (let edit = 0; edit < 20; edit += 1) {
        project.write("elmera-intl.json", edit % 2 === 0 ? FI_TEXT : SV_TEXT);
        yield* afterRead(CONFIG_READ);
      }

      expect([afterOne, held(), events.calls()]).toEqual([[2, 2], [2, 2], 1 + 21 * 2]);
    })
  );
});
