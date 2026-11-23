import { describe, expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import { existsSync, rmSync } from "node:fs";

import { CliPlatform, cliProgram, exitCodeOf } from "../src/cli-run";
import type { ExtractOptions } from "../src/commands";
import { extractCatalogs } from "../src/commands";
import type { ProjectConfig } from "../src/project-config";
import { Reporter } from "../src/reporter";
import type { SyncResult } from "../src/watch";
import { CatalogSync, watchCatalogs, watchProject } from "../src/watch";
import { FileEvents } from "../src/watch-trees";
import type { Project } from "./project-fixture";
import {
  component,
  CONFIG,
  deliveredEvents,
  it,
  lockedRoot,
  POLL_MS,
  POLLING,
  projectConfig,
  watches,
} from "./watch-project";

// The watch's lifecycle in this process, as a host runtime runs it: the executable's program (`cliProgram`) and the Vite
// plugin's watch (`watchProject`), their reporting, their signals, their start and their stop.

// The executable's watch run in this process, reporting through `reporter`, as a host runtime runs the program.
function watchInProcess(project: Project, reporter: Layer.Layer<Reporter>) {
  return cliProgram(["extract", "--watch", "--poll", POLL_MS], { cwd: project.root }).pipe(
    Effect.provide([CliPlatform, reporter, CatalogSync.layer(), FileEvents.layer()])
  );
}

// Runs `program` in this process until the test ends. Then it releases the test's `gates` (a write or a sync it holds)
// and interrupts the program, so a failed assertion leaves no fiber, held write or signal listener behind.
function inProcess<A, E>(
  project: Project,
  program: Effect.Effect<A, E>,
  gates: ReadonlyArray<PromiseWithResolvers<void>> = []
) {
  const fiber = Effect.runFork(program);
  project.defer(async () => {
    gates.forEach((gate) => {
      gate.resolve();
    });
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  return {
    fiber,
    // The program's end, guarded by the test's deadline.
    exit: () => project.within(Effect.runPromise(Fiber.await(fiber)), "the program's end"),
  };
}

// Interrupts a watch running in this process, failing at the project's deadline rather than outliving the test.
function interrupt(project: Project, fiber: Fiber.Fiber<unknown, unknown>): Promise<void> {
  return project.within(Effect.runPromise(Fiber.interrupt(fiber)), "the watch's interruption");
}

describe("extract --watch in this process", { timeout: 20_000 }, () => {
  // An unreadable directory stands in for one the poll must never read: reading it would fail, and the failure would
  // be reported. Oracle: the contract per case, by hand: a directory the config excludes, and node_modules, are pruned
  // before the poll descends; any other unreadable directory is reported once, and the rest of the tree still syncs.
  describe("polling a tree with unreadable directories", () => {
    function lock(project: Project, path: string): void {
      project.write(`${path}/inside.tsx`, component("Hidden"));
      project.lock(path);
    }

    async function watchPolling(project: Project): Promise<Array<string>> {
      const reported: Array<string> = [];
      const watcher = await watchProject(
        projectConfig(project),
        (result) => {
          if (result._tag === "Failed") {
            reported.push(...result.problems.map((problem) => `${problem.code}: ${problem.message}`));
          }
        },
        POLLING
      );
      project.defer(() => watcher.close());

      return reported;
    }

    it("never reads an excluded directory or node_modules, and syncs the rest", async ({ project }) => {
      project.write(
        "elmera-intl.json",
        JSON.stringify({ ...CONFIG, include: ["**/*.tsx"], exclude: ["src/private"] })
      );
      lock(project, "src/private");
      lock(project, "node_modules/some-package");
      const reported = await watchPolling(project);
      await expect.poll(() => project.read("messages/nb.po"), project.guard()).toContain(`msgid "Hello"`);

      project.write("src/page.tsx", component("Edited"));
      await expect.poll(() => project.read("messages/nb.po"), project.guard()).toContain(`msgid "Edited"`);
      expect(reported).toEqual([]);
    });

    it("reports an unreadable directory once, and syncs the rest of the tree", async ({ project }) => {
      lock(project, "src/locked");
      const reported = await watchPolling(project);

      project.write("src/page.tsx", component("Edited"));
      await expect.poll(() => project.read("messages/nb.po"), project.guard()).toContain(`msgid "Edited"`);
      project.write("src/page.tsx", component("Edited again"));
      await expect
        .poll(() => project.read("messages/nb.po"), project.guard())
        .toContain(`msgid "Edited again"`);
      expect(reported.filter((problem) => problem.startsWith("WatchFailed"))).toEqual([
        expect.stringContaining(project.path("src/locked")),
      ]);
    });
  });

  // Unit under test: the watch reporting through a Reporter whose writes complete later, as a host's may (layer 4's
  // Vite logger). Oracle: the executable's lines, written out by hand: the first sync's catalogs, the ready line, then
  // each later sync's catalogs.
  it("reports through an asynchronous Reporter", async ({ project }) => {
    let stdout = "";
    let stderr = "";
    // Each write completes on a later microtask: a write the fiber does not await is lost or fails.
    const later = (append: (text: string) => void) => (text: string) =>
      Effect.promise(() => Promise.resolve()).pipe(
        Effect.andThen(
          Effect.sync(() => {
            append(text);
          })
        )
      );
    const reporter = Layer.succeed(Reporter, {
      stdout: later((text) => {
        stdout += text;
      }),
      stderr: later((text) => {
        stderr += text;
      }),
    });
    const { fiber } = inProcess(project, watchInProcess(project, reporter));
    const ready = `wrote messages/nb.po\nwatching ${project.root} for message changes; Ctrl-C stops\n`;
    await expect.poll(() => stdout, project.guard()).toContain("watching");
    expect(stdout).toBe(ready);
    project.write("src/new.tsx", component("New"));
    await expect.poll(() => stdout, project.guard()).toBe(`${ready}wrote messages/nb.po\n`);
    await interrupt(project, fiber);

    expect(stderr).toBe("");
  });

  // Unit under test: the watch's reporting when a Reporter write throws, as a host's may (layer 4). Oracle: layer 1's
  // handling, written out by hand: each failed write is reported as its sync's SyncFailed, before the ready line and
  // after it, and the watch goes on.
  it("reports a write that throws as SyncFailed, and keeps watching", async ({ project }) => {
    let stdout = "";
    let stderr = "";
    // The first sync's write fails, and so does the first after the ready line.
    let failures = 2;
    const reporter = Reporter.layer({
      stdout: (text) => {
        if (failures > 0 && text.startsWith("wrote")) {
          failures -= 1;
          throw new Error("stdout gone");
        }

        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    inProcess(project, watchInProcess(project, reporter));
    const ready = `watching ${project.root} for message changes; Ctrl-C stops\n`;
    const syncFailed =
      "SyncFailed: stdout gone\n  fix: fix the file the error names; the next change retries\n";
    await expect.poll(() => stdout, project.guard()).toBe(ready);
    expect(stderr).toBe(syncFailed);
    project.write("src/new.tsx", component("New"));
    await expect.poll(() => stderr, project.guard()).toBe(`${syncFailed}${syncFailed}`);
    project.write("src/newer.tsx", component("Newer"));
    await expect.poll(() => stdout, project.guard()).toBe(`${ready}wrote messages/nb.po\n`);
  });

  // When the SyncFailed report cannot be written either, nothing reports the watch any more: it must end with that
  // failure, its watcher closed and its signal listeners gone, rather than go on writing catalogs unreported.
  it("ends when a failed write cannot be reported either", async ({ project }) => {
    let stdout = "";
    let broken = false;
    const reporter = Reporter.layer({
      stdout: (text) => {
        if (broken) {
          throw new Error("stdout gone");
        }

        stdout += text;
      },
      stderr: () => {
        if (broken) {
          throw new Error("stderr gone");
        }
      },
    });
    const listeners = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const before = listeners();
    const running = inProcess(project, watchInProcess(project, reporter));
    await expect.poll(() => stdout, project.guard()).toContain("watching");
    expect(listeners()).toEqual(before.map((count) => count + 1));
    broken = true;
    project.write("src/new.tsx", component("New"));
    const exit = await running.exit();

    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toEqual(new Error("stderr gone"));
    expect(listeners()).toEqual(before);
  });

  // A reporter whose `hold`th write matching `held` waits for `gate`, then writes (or, given `fails`, throws it). Every
  // other write lands at once.
  function holdingReporter(options: {
    readonly held: (text: string) => boolean;
    readonly gate: Promise<void>;
    readonly fails?: Error;
    readonly stderr?: (text: string) => Effect.Effect<void>;
  }) {
    const out = { stdout: "", stderr: "", holding: false };
    const reporter = Layer.succeed(Reporter, {
      stdout: Effect.fnUntraced(function* (text: string) {
        if (!out.holding && options.held(text)) {
          out.holding = true;
          yield* Effect.promise(() => options.gate);

          if (options.fails !== undefined) {
            return yield* Effect.die(options.fails);
          }
        }

        out.stdout += text;
      }),
      stderr:
        options.stderr ??
        ((text: string) =>
          Effect.sync(() => {
            out.stderr += text;
          })),
    });

    return { out, reporter };
  }

  // SIGTERM to the in-process CLI: the one listener it added, called as Node calls it, so the test's process gets no
  // signal. A CLI that added none fails here, rather than ending some other way.
  function sigtermCli(before: ReadonlyArray<unknown>): void {
    const added = process.listeners("SIGTERM").filter((listener) => !before.includes(listener));
    expect(added).toHaveLength(1);
    added.forEach((listener) => {
      listener("SIGTERM");
    });
  }

  // Unit under test: the executable's watch on native events, run in this process. Oracle: layer 2's executable, by
  // hand: a signal closes the watchers at once, while the ready line is still being written, and the watch then drains
  // and exits 0.
  it("closes its watchers at the signal, while the ready write is held", async ({ project }) => {
    const opened = watches();
    const gate = Promise.withResolvers<void>();
    const { out, reporter } = holdingReporter({
      held: (text) => text.startsWith("watching"),
      gate: gate.promise,
    });
    const before = process.listeners("SIGTERM");
    const running = inProcess(
      project,
      cliProgram(["extract", "--watch"], { cwd: project.root }).pipe(
        Effect.provide([CliPlatform, reporter, CatalogSync.layer(), FileEvents.layer()])
      ),
      [gate]
    );
    await expect.poll(() => out.holding, project.guard()).toBe(true);
    // Its watchers are open (on Linux, set up per directory as the event loop runs).
    await expect.poll(watches, project.guard()).toBeGreaterThan(opened);
    sigtermCli(before);
    await expect.poll(watches, project.guard()).toBe(opened);
    expect(out.stdout).toBe("wrote messages/nb.po\n");
    gate.resolve();
    const exit = await running.exit();

    expect([exitCodeOf(exit), out.stdout]).toEqual([
      0,
      `wrote messages/nb.po\nwatching ${project.root} for message changes; Ctrl-C stops\n`,
    ]);
  });

  // Oracle: layer 2's executable, for each case by hand: syncs go on while a write is held, and every result is written
  // after it, in order. Two catalogs, so the results queued behind the held write differ: a source edit writes both,
  // then a repair of one catalog writes that one.
  it("keeps syncing while a write is held, and writes every result in order", async ({ project }) => {
    project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, locales: ["nb", "sv"] }));
    const gate = Promise.withResolvers<void>();
    let wrote = 0;
    const { out, reporter } = holdingReporter({
      held: (text) => text.startsWith("wrote") && ++wrote === 2,
      gate: gate.promise,
    });
    inProcess(project, watchInProcess(project, reporter), [gate]);
    const both = "wrote messages/nb.po, messages/sv.po\n";
    const ready = `${both}watching ${project.root} for message changes; Ctrl-C stops\n`;
    await expect.poll(() => out.stdout, project.guard()).toBe(ready);
    project.write("src/middle.tsx", component("Middle"));
    await expect.poll(() => out.holding, project.guard()).toBe(true);
    project.write("src/after.tsx", component("After"));
    await expect.poll(() => project.read("messages/sv.po"), project.guard()).toContain(`msgid "After"`);
    rmSync(project.path("messages/sv.po"));
    await expect.poll(() => existsSync(project.path("messages/sv.po")), project.guard()).toBe(true);
    expect(out.stdout).toBe(ready);

    gate.resolve();
    await expect.poll(() => out.stdout, project.guard()).toBe(`${ready}${both}${both}wrote messages/sv.po\n`);
  });

  // Unit under test: the executable's watch on native events, run in this process, the events delivered by the test.
  // Oracle: layer 2's executable, by hand: a watcher's error delivered just before the signal is printed, with its fix,
  // and one delivered just after it, in the same turn, is not; either way the sync the signal lands in still writes
  // its result, and the watch exits 0. That sync is held over the signal, so the stop is still draining when the late
  // error arrives.
  it.for([
    ["before", true],
    ["after", false],
  ] as const)(
    "prints a watcher's error delivered just %s the signal only when it came first",
    async ([when, printed], { project }) => {
      const events = deliveredEvents();
      const held = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      let calls = 0;
      const holding = Layer.succeed(CatalogSync, {
        extract: Effect.fnUntraced(function* (config: ProjectConfig, options: ExtractOptions) {
          calls += 1;

          if (calls === 2) {
            held.resolve();
            yield* Effect.promise(() => gate.promise);
          }

          return extractCatalogs(config, options);
        }),
      });
      let stdout = "";
      let stderr = "";
      const reporter = Reporter.layer({
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      });
      const before = process.listeners("SIGTERM");
      const running = inProcess(
        project,
        cliProgram(["extract", "--watch"], { cwd: project.root }).pipe(
          Effect.provide([CliPlatform, reporter, holding, events.layer])
        ),
        [gate]
      );
      await expect.poll(() => stdout, project.guard()).toContain("watching");
      expect(events.open()).toHaveLength(1);
      const [tree = ""] = events.open();
      // Taken before the signal: an error the platform already dispatched still reaches it after the stop.
      const listener = events.listener(tree);
      project.write("src/new.tsx", component("New"));
      listener.change("rename", "src/new.tsx");
      await project.within(held.promise, "the held sync");
      const fail = () => {
        listener.error(new Error("EMFILE: too many open files"));
      };

      if (when === "before") {
        fail();
        sigtermCli(before);
      } else {
        sigtermCli(before);
        fail();
      }

      gate.resolve();
      const exit = await running.exit();

      expect([exitCodeOf(exit), stderr, stdout.endsWith("Ctrl-C stops\nwrote messages/nb.po\n")]).toEqual([
        0,
        printed
          ? `WatchFailed: stopped watching ${project.root}: EMFILE: too many open files\n  fix: restart \`elmera-intl extract --watch\`\n`
          : "",
        true,
      ]);
    }
  );

  it("writes the ready line before a later sync's result, while the ready write is held", async ({
    project,
  }) => {
    const gate = Promise.withResolvers<void>();
    const { out, reporter } = holdingReporter({
      held: (text) => text.startsWith("watching"),
      gate: gate.promise,
    });
    inProcess(project, watchInProcess(project, reporter), [gate]);
    await expect.poll(() => out.holding, project.guard()).toBe(true);
    project.write("src/new.tsx", component("New"));
    await expect.poll(() => project.read("messages/nb.po"), project.guard()).toContain(`msgid "New"`);
    expect(out.stdout).toBe("wrote messages/nb.po\n");

    gate.resolve();
    await expect
      .poll(() => out.stdout, project.guard())
      .toBe(
        `wrote messages/nb.po\nwatching ${project.root} for message changes; Ctrl-C stops\nwrote messages/nb.po\n`
      );
  });

  // Oracle: layer 2's executable: a write held when the signal lands still fails the watch for good when neither it nor
  // its SyncFailed can be written, and the watch exits with that failure, not 0.
  it("exits with a write that fails for good after the signal", async ({ project }) => {
    const gate = Promise.withResolvers<void>();
    let wrote = 0;
    const { out, reporter } = holdingReporter({
      held: (text) => text.startsWith("wrote") && ++wrote === 2,
      gate: gate.promise,
      fails: new Error("stdout gone"),
      stderr: () => Effect.die(new Error("stderr gone")),
    });
    const before = process.listeners("SIGTERM");
    const running = inProcess(project, watchInProcess(project, reporter), [gate]);
    await expect.poll(() => out.stdout, project.guard()).toContain("watching");
    project.write("src/new.tsx", component("New"));
    await expect.poll(() => out.holding, project.guard()).toBe(true);
    sigtermCli(before);
    gate.resolve();
    const exit = await running.exit();

    expect([exitCodeOf(exit), Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit]).toEqual([
      2,
      new Error("stderr gone"),
    ]);
  });

  // Unit under test: `watchProject`, the Vite plugin's watch. Oracle: layer 2's plugin, by hand: a report that throws
  // is reported again as that sync's SyncFailed, and the next change still syncs.
  it("reports a report that throws as SyncFailed through watchProject, and keeps syncing", async ({
    project,
  }) => {
    const results: Array<string> = [];
    let written = 0;
    const watcher = await watchProject(
      projectConfig(project),
      (result) => {
        if (result._tag === "Written" && ++written === 2) {
          throw new Error("logger busy");
        }

        results.push(
          result._tag === "Failed"
            ? result.problems.map((problem) => `${problem.code}: ${problem.message}`).join("\n")
            : result._tag
        );
      },
      POLLING
    );
    project.defer(() => watcher.close());
    await expect.poll(() => results, project.guard()).toEqual(["Written"]);
    project.write("src/middle.tsx", component("Middle"));
    await expect.poll(() => results, project.guard()).toEqual(["Written", "SyncFailed: logger busy"]);
    project.write("src/end.tsx", component("End"));
    await expect
      .poll(() => results, project.guard())
      .toEqual(["Written", "SyncFailed: logger busy", "Written"]);
    expect(project.read("messages/nb.po")).toContain(`msgid "End"`);
  });

  // Unit under test: the executable's watch run in this process, as a host runtime runs the program with the
  // `CatalogSync` it provides. Oracle: the contract by hand: the host's service outlives the watch, so interrupting the
  // program while a sync is held lets that sync finish before the host's layer is released.
  it("releases the host's CatalogSync after a held sync, when the program is interrupted", async ({
    project,
  }) => {
    const log: Array<string> = [];
    const held = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    const recording = Layer.effect(
      CatalogSync,
      Effect.acquireRelease(
        Effect.succeed({
          extract: Effect.fnUntraced(function* (config: ProjectConfig, options: ExtractOptions) {
            calls += 1;

            if (calls === 2) {
              held.resolve();
              yield* Effect.promise(() => gate.promise);
              log.push("sync resumed");
            }

            return extractCatalogs(config, options);
          }),
        }),
        () =>
          Effect.sync(() => {
            log.push("layer released");
          })
      )
    );
    let stdout = "";
    const reporter = Reporter.layer({
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => undefined,
    });
    const { fiber } = inProcess(
      project,
      cliProgram(["extract", "--watch", "--poll", POLL_MS], { cwd: project.root }).pipe(
        Effect.provide([CliPlatform, reporter, recording, FileEvents.layer()])
      ),
      [gate]
    );
    await expect.poll(() => stdout, project.guard()).toContain("watching");
    project.write("src/new.tsx", component("New"));
    await project.within(held.promise, "the held sync");
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    log.push("gate released");
    gate.resolve();
    await project.within(interrupted, "the interruption");

    expect(log).toEqual(["gate released", "sync resumed", "layer released"]);
  });

  // Unit under test: `watchProject`, as the Vite plugin starts it. Oracle: layer 2's plugin, by hand: when the first
  // sync's report throws and so does its SyncFailed, the start fails with that error (layer 2 threw it from the
  // plugin's start), and only after every watcher it opened is closed, rather than the error escaping later.
  it("rejects its start when the first result cannot be reported, its watchers closed", async ({
    project,
  }) => {
    const before = watches();
    const reports: Array<SyncResult["_tag"]> = [];
    const starting = watchProject(projectConfig(project), (result) => {
      reports.push(result._tag);
      throw new Error(result._tag === "Failed" ? "logger.error gone" : "logger.info gone");
    });

    await expect(project.within(starting, "the start")).rejects.toThrow("logger.error gone");
    expect(reports).toEqual(["Written", "Failed"]);
    await expect.poll(watches, project.guard()).toBe(before);
  });

  // Unit under test: the executable's watch run in this process, with a host's file events that open asynchronously.
  // Oracle: the contract by hand, as for a signal during the watch: a signal while the watchers are still opening ends
  // the start with no first sync, nothing written, and the program exits 0.
  it("exits 0 on a signal while its watchers are opening", async ({ project }) => {
    const opening = Promise.withResolvers<void>();
    const events = deliveredEvents({ opening: () => opening.promise });
    let stdout = "";
    const reporter = Reporter.layer({
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => undefined,
    });
    const before = process.listeners("SIGTERM");
    const running = inProcess(
      project,
      cliProgram(["extract", "--watch"], { cwd: project.root }).pipe(
        Effect.provide([CliPlatform, reporter, CatalogSync.layer(), events.layer])
      ),
      [opening]
    );
    await expect.poll(() => events.opening(), project.guard()).toBe(1);
    sigtermCli(before);
    const exit = await running.exit();

    expect([exitCodeOf(exit), stdout, existsSync(project.path("messages/nb.po"))]).toEqual([0, "", false]);
  });

  // Unit under test: the executable's watch run in this process, signalled as soon as its signal listeners are on, before
  // its start opens any tree. Oracle: the contract by hand: the stop came first, so the watch opens no tree (here one
  // whose watch would fail with EACCES), runs no sync, writes nothing, and the program exits 0.
  it("exits 0 on a signal right after its listeners are on, opening no tree", async ({ project }) => {
    const events = deliveredEvents({
      refuses: { dir: project.root, error: new Error("EACCES: permission denied, watch") },
    });
    let stdout = "";
    const reporter = Reporter.layer({
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => undefined,
    });
    const before = process.listeners("SIGTERM");
    const running = inProcess(
      project,
      cliProgram(["extract", "--watch"], { cwd: project.root }).pipe(
        Effect.provide([CliPlatform, reporter, CatalogSync.layer(), events.layer])
      )
    );
    sigtermCli(before);
    const exit = await running.exit();

    expect([exitCodeOf(exit), events.calls(), stdout, existsSync(project.path("messages/nb.po"))]).toEqual([
      0,
      0,
      "",
      false,
    ]);
  });

  // Unit under test: the executable's watch run in this process, interrupted as a host runtime shutting down
  // interrupts it. Oracle: the contract by hand: the interruption still runs the watch's stop, and a watcher that fails
  // to close is a defect the interruption does not hide: the program dies with it, so the executable reports a crash.
  it("ends with a watcher's close failure when the program is interrupted", async ({ project }) => {
    const events = deliveredEvents({ closeFails: new Error("close failed") });
    let stdout = "";
    const reporter = Reporter.layer({
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => undefined,
    });
    const running = inProcess(
      project,
      cliProgram(["extract", "--watch"], { cwd: project.root }).pipe(
        Effect.provide([CliPlatform, reporter, CatalogSync.layer(), events.layer])
      )
    );
    await expect.poll(() => stdout, project.guard()).toContain("watching");
    await interrupt(project, running.fiber);
    const exit = await running.exit();

    expect([exitCodeOf(exit), Exit.isFailure(exit) && Cause.hasDies(exit.cause)]).toEqual([2, true]);
    expect(Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : exit).toBe("Error: close failed");
  });

  // Oracle: the contract by hand, as for the close failure above: interrupted while a write is held, the program still
  // drains it; when neither it nor its SyncFailed can be written, it dies with that failure, not with the interruption
  // alone.
  it("ends with a write that fails for good when the program is interrupted while it is held", async ({
    project,
  }) => {
    const gate = Promise.withResolvers<void>();
    let wrote = 0;
    const { out, reporter } = holdingReporter({
      held: (text) => text.startsWith("wrote") && ++wrote === 2,
      gate: gate.promise,
      fails: new Error("stdout gone"),
      stderr: () => Effect.die(new Error("stderr gone")),
    });
    const running = inProcess(project, watchInProcess(project, reporter), [gate]);
    await expect.poll(() => out.stdout, project.guard()).toContain("watching");
    project.write("src/new.tsx", component("New"));
    await expect.poll(() => out.holding, project.guard()).toBe(true);
    const interrupting = interrupt(project, running.fiber);
    gate.resolve();
    await interrupting;
    const exit = await running.exit();

    expect([exitCodeOf(exit), Exit.isFailure(exit) && Cause.hasDies(exit.cause)]).toEqual([2, true]);
    expect(Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : exit).toBe("Error: stderr gone");
  });

  // Linux only: there a recursive watch of an unreadable directory fails as it starts, where macOS's event daemon
  // watches it all the same. Oracle: the contract by hand: the watches already started on the readable roots are
  // closed, and the signal listeners come off, so signals are Node's again.
  // Unit under test: `watchCatalogs` in a caller scope that closes before, or while, it starts, on native events a test
  // records. Oracle: the contract by hand: a watch's scope may close at any point, and its start and the close both
  // settle, with every watcher it opened closed; a scope closed before the start opens none and syncs nothing.
  describe("a caller scope that closes before or during the start", () => {
    function watchIn(project: Project, scope: Scope.Scope, events: Layer.Layer<FileEvents>) {
      return watchCatalogs(projectConfig(project), { _tag: "native" }, Deferred.makeUnsafe<void>(), {
        report: () => Effect.void,
        ready: Effect.void,
      }).pipe(Scope.provide(scope), Effect.provide([CatalogSync.layer(), events]));
    }

    it("settles its start in a scope closed already, opening no tree", async ({ project }) => {
      const events = deliveredEvents();
      const scope = Scope.makeUnsafe();
      await Effect.runPromise(Scope.close(scope, Exit.void));
      const exit = await project.within(
        Effect.runPromiseExit(watchIn(project, scope, events.layer)),
        "the start"
      );

      expect([exit._tag, events.calls(), events.open(), existsSync(project.path("messages/nb.po"))]).toEqual([
        "Success",
        0,
        [],
        false,
      ]);
    });

    // With the scheduler yielding after every operation, the close lands after each number of the start's yields in
    // turn, until the start has ended before it.
    it("settles its start and the close wherever the close lands in the start", async ({ project }) => {
      const events = deliveredEvents();
      const sweep = Effect.gen(function* () {
        const unsettled: Array<number> = [];

        for (let yields = 0; yields < 1_000; yields += 1) {
          const scope = yield* Scope.make();
          const starting = yield* Effect.forkDetach(watchIn(project, scope, events.layer));

          for (let turn = 0; turn < yields; turn += 1) {
            yield* Effect.yieldNow;
          }

          const startedFirst = starting.pollUnsafe() !== undefined;
          yield* Scope.close(scope, Exit.void);
          const exit = yield* Fiber.await(starting);

          if (!Exit.isSuccess(exit) || events.open().length > 0) {
            unsettled.push(yields);
          }

          if (startedFirst) {
            return { swept: yields > 0, unsettled };
          }
        }

        return { swept: false, unsettled };
      }).pipe(Effect.provideService(References.MaxOpsBeforeYield, 1));

      expect(await project.within(Effect.runPromise(sweep), "the sweep")).toEqual({
        swept: true,
        unsettled: [],
      });
    });
  });

  describe.skipIf(process.platform !== "linux")("a watcher that fails to start", () => {
    // Unit under test: `watchProject`, as the Vite plugin starts it. Its start rejects after every watch it started is
    // closed, so a failed dev-server start leaves no handle behind.
    it("closes the watches it started when watchProject fails to start", async ({ project }) => {
      lockedRoot(project);
      const before = watches();

      await expect(
        project.within(
          watchProject(projectConfig(project), () => undefined),
          "the start"
        )
      ).rejects.toThrow(/EACCES/u);
      // A closed watch's handles are released by the event loop (on Linux, one per directory).
      await expect.poll(watches, project.guard()).toBe(before);
    });

    it("takes its signal listeners off, and closes the watches it started", async ({ project }) => {
      lockedRoot(project);
      const listeners = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
      const before = listeners();
      const opened = watches();
      const reporter = Reporter.layer({ stdout: () => undefined, stderr: () => undefined });
      const exit = await inProcess(
        project,
        cliProgram(["extract", "--watch"], { cwd: project.root }).pipe(
          Effect.provide([CliPlatform, reporter, CatalogSync.layer(), FileEvents.layer()])
        )
      ).exit();

      expect(exitCodeOf(exit)).toBe(2);
      expect(Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : exit).toMatch(/^Error: EACCES/u);
      expect(listeners()).toEqual(before);
      // A closed watch's handles are released by the event loop (on Linux, one per directory).
      await expect.poll(watches, project.guard()).toBe(opened);
    });
  });
});
