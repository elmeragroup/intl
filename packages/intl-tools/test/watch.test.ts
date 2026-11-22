import { describe, expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { CliPlatform, cliProgram, exitCodeOf } from "../src/cli-run";
import { runOnceInProcess } from "../src/command-run";
import type { ExtractOptions } from "../src/commands";
import { extractCatalogs, planCatalogs, writeCatalogs } from "../src/commands";
import { parsePo } from "../src/po";
import type { ProjectConfig } from "../src/project-config";
import { Reporter } from "../src/reporter";
import type { SyncResult, WatchOutput } from "../src/watch";
import { CatalogSync, FileEvents, watchCatalogs, watchProject } from "../src/watch";
import type { Project } from "./project-fixture";
import {
  component,
  CONFIG,
  deliveredEvents,
  IMPORT,
  it,
  POLL_MS,
  POLLING,
  projectConfig,
  syncing,
} from "./watch-project";

// The built executable, as the CLI ships: the watch's output and signal handling are the bin's.
const BIN = fileURLToPath(new URL("../bin/elmera-intl.js", import.meta.url));
const HEADER = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=utf-8\\n"
"Content-Transfer-Encoding: 8bit\\n"
"Language: nb\\n"
"X-Elmera-Serializer: 1\\n"
`;

// The timeout of a test whose watch walks 300 unreadable directories, which under load outlasts the default.
const WALK_TEST = { timeout: 30_000 };

// The guard of a poll that rewrites its trigger each round: slower rounds, so each rewrite can be synced.
function probe(project: Project) {
  return { ...project.guard(), interval: 500 };
}

// One-shot extract, then a msgstr for each pair.
async function extractTranslated(
  project: Project,
  pairs: ReadonlyArray<readonly [string, string]>
): Promise<void> {
  expect(
    await project.within(
      runOnceInProcess(
        "extract",
        { configPath: project.path("elmera-intl.json"), crash: "reject" },
        { stdout: () => undefined, stderr: () => undefined }
      ),
      "the one-shot extract"
    )
  ).toBe("ok");
  let po = project.read("messages/nb.po");
  for (const [source, translation] of pairs) {
    po = po.replace(`msgid "${source}"\nmsgstr ""`, `msgid "${source}"\nmsgstr "${translation}"`);
  }
  project.write("messages/nb.po", po);
}

// A watch's output that writes nothing.
const QUIET: WatchOutput<never> = { report: () => Effect.void, ready: Effect.void };

function translations(project: Project): ReadonlyMap<string, string> {
  const parsed = parsePo(project.read("messages/nb.po"));

  return new Map(
    parsed._tag === "Parsed" ? parsed.file.entries.map((entry) => [entry.source, entry.translation]) : []
  );
}

// The file watchers open in this process: one per native watch on macOS, one per watched directory on Linux.
function watches(): number {
  return process.getActiveResourcesInfo().filter((name) => name === "FSEventWrap").length;
}

type Watcher = {
  /** stdout from the start until the watch was live: the first sync's report and the ready line. */
  readonly startup: () => string;
  readonly output: () => { readonly stdout: string; readonly stderr: string };
  readonly kill: (signal: NodeJS.Signals) => Promise<number | null>;
};

// Resolves once the watch prints its ready line; `output()` starts after it. The watch polls, and its first walk is
// taken before its first sync, so every edit after the ready line is seen. Nothing the test did before is still
// pending then: the files it wrote are in that walk, and the first sync, which has ended, wrote the catalog as its own.
// So a test acts on a settled watch, and no sync it did not cause can overlap what it does next. The watch is killed
// at the project's deadline, and when the test ends.
async function startWatch(project: Project): Promise<Watcher> {
  const child: ChildProcess = spawn(execPath, [BIN, "extract", "--watch", "--poll", POLL_MS], {
    cwd: project.root,
    ...project.spawnGuard(),
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (text: string) => {
    stdout += text;
  });
  child.stderr?.setEncoding("utf8").on("data", (text: string) => {
    stderr += text;
  });
  const closed = new Promise<number | null>((done) => {
    child.on("close", (code) => {
      done(code);
    });
  });
  let live = { stdout: 0, stderr: 0 };
  const watcher: Watcher = {
    startup: () => stdout.slice(0, live.stdout),
    output: () => ({ stdout: stdout.slice(live.stdout), stderr: stderr.slice(live.stderr) }),
    kill: (signal) => {
      child.kill(signal);

      return closed;
    },
  };
  project.defer(async () => {
    await watcher.kill("SIGKILL");
  });
  await expect.poll(() => stdout, project.guard()).toContain("Ctrl-C stops\n");
  live = { stdout: stdout.length, stderr: stderr.length };

  return watcher;
}

// The executable's watch run in this process, reporting through `reporter`, as a host runtime runs the program.
function watchInProcess(project: Project, reporter: Layer.Layer<Reporter>) {
  return cliProgram(["extract", "--watch", "--poll", POLL_MS], { cwd: project.root }).pipe(
    Effect.provide([CliPlatform, reporter, CatalogSync.layer(), FileEvents.layer()])
  );
}

// Interrupts a watch running in this process, failing at the project's deadline rather than outliving the test.
function interrupt(project: Project, fiber: Fiber.Fiber<unknown, unknown>): Promise<void> {
  return project.within(
    Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.asVoid)),
    "the watch's interruption"
  );
}

// Unit under test: `elmera-intl extract --watch`. Oracle: the PO text written per case, by hand.
describe("extract --watch", { timeout: 20_000 }, () => {
  it("adds a new message to the PO", async ({ project }) => {
    await startWatch(project);
    project.write("src/new.tsx", component("New"));
    await expect
      .poll(() => project.read("messages/nb.po"), project.guard())
      .toContain(`msgid "New"\nmsgstr ""`);
  });

  it.live("keeps a msgstr saved right after the sync that added its message", ({ project }) =>
    Effect.gen(function* () {
      const po = project.path("messages/nb.po");
      let saved = false;
      yield* watchCatalogs(projectConfig(project), POLLING, yield* Deferred.make<void>(), QUIET).pipe(
        Effect.provide([
          FileEvents.layer(),
          syncing((config, options) => {
            const result = extractCatalogs(config, options);
            const added = result.written.find(
              ({ path, text }) => path === po && text.includes(`msgid "Ready"`)
            );

            // The save lands after the sync's writes, before the sync step returns.
            if (!saved && added !== undefined) {
              saved = true;
              project.write(
                "messages/nb.po",
                added.text.replace(`msgid "Ready"\nmsgstr ""`, `msgid "Ready"\nmsgstr "Klar"`)
              );
            }

            return result;
          }),
        ])
      );
      // The trigger is rewritten until the watch syncs it. It stops once the PO has the message: one more source event
      // would sync again and compile the edit whether or not the watch saw it.
      yield* Effect.promise(() =>
        expect
          .poll(() => {
            if (!project.read("messages/nb.po").includes(`msgid "Ready"`)) {
              project.write("src/ready.tsx", component("Ready"));
            }

            return project.read("messages/nb.po");
          }, probe(project))
          .toContain(`msgid "Ready"\nmsgstr "Klar"`)
      );
      // A sync after the save, which must merge it rather than write the PO it read before.
      project.write("src/after.tsx", component("After"));
      yield* Effect.promise(() =>
        expect.poll(() => project.read("messages/nb.po"), project.guard()).toContain(`msgid "After"`)
      );

      expect(project.read("messages/nb.po")).toContain(`msgid "Ready"\nmsgstr "Klar"`);
    })
  );

  it.live("keeps a msgstr saved while a sync runs", ({ project }) =>
    Effect.gen(function* () {
      const po = project.path("messages/nb.po");
      let saved = false;
      yield* watchCatalogs(projectConfig(project), POLLING, yield* Deferred.make<void>(), QUIET).pipe(
        Effect.provide([
          FileEvents.layer(),
          syncing((config, options) => {
            const plan = planCatalogs(config, options);

            // The save lands after the sync read the PO and before it writes.
            if (
              !saved &&
              plan.outputs.some(({ path, text }) => path === po && text.includes(`msgid "Ready"`))
            ) {
              saved = true;
              project.write(
                "messages/nb.po",
                project
                  .read("messages/nb.po")
                  .replace(`msgid "Hello"\nmsgstr ""`, `msgid "Hello"\nmsgstr "Hei"`)
              );
            }

            return writeCatalogs(plan, options);
          }),
        ])
      );
      // The trigger is rewritten until a sync writes it.
      yield* Effect.promise(() =>
        expect
          .poll(() => {
            if (!project.read("messages/nb.po").includes(`msgid "Ready"`)) {
              project.write("src/ready.tsx", component("Ready"));
            }

            return project.read("messages/nb.po");
          }, probe(project))
          .toContain(`msgid "Ready"`)
      );
      yield* Effect.promise(() =>
        expect
          .poll(() => project.read("messages/nb.po"), project.guard())
          .toContain(`msgid "Hello"\nmsgstr "Hei"`)
      );
    })
  );

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

  it("keeps a deleted message's entry and translation", async ({ project }) => {
    await extractTranslated(project, [["Hello", "Hei"]]);
    await startWatch(project);
    // The added message is the signal that the sync after the deletion ran.
    project.write("src/other.tsx", component("Other"));
    unlinkSync(project.path("src/page.tsx"));
    await expect.poll(() => project.read("messages/nb.po"), project.guard()).toContain(`msgid "Other"`);

    expect(project.read("messages/nb.po")).toBe(`${HEADER}
#: src/page.tsx
msgid "Hello"
msgstr "Hei"

#: src/other.tsx
msgid "Other"
msgstr ""
`);
  });

  it("prints a syntax error, leaves the catalog byte-identical, and resumes once the file is fixed", async ({
    project,
  }) => {
    await extractTranslated(project, [["Hello", "Hei"]]);
    const po = project.read("messages/nb.po");
    const { output } = await startWatch(project);
    project.write("src/broken.tsx", `${IMPORT}export const C = () => <T>Broken</T;\n`);
    // One line: a late probe report also says ExtractFailed.
    await expect
      .poll(() => output().stderr, project.guard())
      .toMatch(/src\/broken\.tsx[^\n]*: ExtractFailed:/u);

    expect(project.read("messages/nb.po")).toBe(po);

    project.write("src/broken.tsx", component("Fixed"));
    await expect.poll(() => project.read("messages/nb.po"), project.guard()).toContain(`msgid "Fixed"`);
  });

  it("ends a 300-file burst with every new message and every existing translation", async ({ project }) => {
    const files = Array.from({ length: 300 }, (_, i) => i);
    files.forEach((i) => {
      project.write(`src/gen/f${i}.tsx`, component(`Message ${i}`));
    });
    await extractTranslated(
      project,
      files.map((i) => [`Message ${i}`, `Melding ${i}`])
    );
    await startWatch(project);
    // A branch switch: every file rewritten at once.
    files.forEach((i) => {
      project.write(`src/gen/f${i}.tsx`, component(`Message ${i} v2`));
    });

    const expected = new Map<string, string>([
      ["Hello", ""],
      ...files.flatMap((i): ReadonlyArray<readonly [string, string]> => [
        [`Message ${i}`, `Melding ${i}`],
        [`Message ${i} v2`, ""],
      ]),
    ]);
    await expect.poll(() => translations(project), project.guard()).toEqual(expected);
  });

  it("syncs a file added under a ./-prefixed include pattern", async ({ project }) => {
    project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, include: ["./src/**/*.{ts,tsx}"] }));
    await startWatch(project);
    project.write("src/new.tsx", component("New"));
    await expect
      .poll(() => project.read("messages/nb.po"), project.guard())
      .toContain(`#: src/new.tsx\nmsgid "New"`);
  });

  it("ignores a save under an excluded directory", async ({ project }) => {
    project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, exclude: ["src/skip"] }));
    await startWatch(project);
    project.write("src/skip/draft.tsx", component("Draft"));
    // The included save is the signal that a sync after the excluded one ran.
    project.write("src/new.tsx", component("New"));
    await expect.poll(() => project.read("messages/nb.po"), project.guard()).toContain(`msgid "New"`);

    expect(project.read("messages/nb.po")).not.toContain("Draft");
  });

  it("syncs a populated directory moved into an include root", async ({ project }) => {
    project.write("staging/feature/a.tsx", component("Moved in"));
    await startWatch(project);
    renameSync(project.path("staging/feature"), project.path("src/feature"));
    await expect
      .poll(() => project.read("messages/nb.po"), project.guard())
      .toContain(`#: src/feature/a.tsx\nmsgid "Moved in"`);
  });

  it("keeps a moved-out directory's entries while syncing the one moved in", async ({ project }) => {
    project.write("src/old/a.tsx", component("Moved out"));
    project.write("staging/new/b.tsx", component("Moved in"));
    await extractTranslated(project, [["Moved out", "Flyttet ut"]]);
    await startWatch(project);
    renameSync(project.path("src/old"), project.path("staging/old"));
    renameSync(project.path("staging/new"), project.path("src/new"));
    await expect
      .poll(() => translations(project), project.guard())
      .toEqual(
        new Map([
          ["Hello", ""],
          ["Moved out", "Flyttet ut"],
          ["Moved in", ""],
        ])
      );
  });

  it("reports a sync that throws and keeps watching", async ({ project }) => {
    const { output } = await startWatch(project);
    // A directory where the PO goes: reading it throws, an I/O failure the CLI does not classify.
    rmSync(project.path("messages/nb.po"));
    mkdirSync(project.path("messages/nb.po"));
    project.write("src/first.tsx", component("First"));
    await expect.poll(() => output().stderr, project.guard()).toContain("SyncFailed");

    rmSync(project.path("messages/nb.po"), { recursive: true });
    project.write("src/second.tsx", component("Second"));
    await expect.poll(() => project.read("messages/nb.po"), project.guard()).toContain(`msgid "Second"`);
  });

  // Oracle: the report lines, written out by hand: the first sync's catalogs, then the ready line naming the project
  // root, then each later sync's catalogs, relative to the root.
  it("prints what each sync writes, and the ready line after the first", async ({ project }) => {
    const running = await startWatch(project);
    project.write("src/new.tsx", component("New"));
    await expect.poll(() => running.output().stdout, project.guard()).toBe("wrote messages/nb.po\n");

    expect(running.startup()).toBe(
      `wrote messages/nb.po\nwatching ${realpathSync(project.root)} for message changes; Ctrl-C stops\n`
    );
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
    const fiber = Effect.runFork(watchInProcess(project, reporter));
    const ready = `wrote messages/nb.po\nwatching ${project.root} for message changes; Ctrl-C stops\n`;
    try {
      await expect.poll(() => stdout, project.guard()).toContain("watching");
      expect(stdout).toBe(ready);
      project.write("src/new.tsx", component("New"));
      await expect.poll(() => stdout, project.guard()).toBe(`${ready}wrote messages/nb.po\n`);
    } finally {
      await interrupt(project, fiber);
    }

    expect(stderr).toBe("");
  });

  // A signal that lands while a sync runs ends the watch after that sync, whose result is still reported. Oracle: the
  // layer 1 executable's stderr for this case, written out by hand, and its exit 0. The catalog becomes a FIFO the next
  // sync blocks reading (the writer opens once it does), so the signal lands mid-sync without timing. The test only
  // writes the FIFO, and never from a blocking open: nothing on its thread waits on the watch's reader.
  it.for(["SIGINT", "SIGTERM"] as const)(
    "reports the sync a %s lands in, then exits 0",
    async (signal, { project }) => {
      await extractTranslated(project, []);
      const running = await startWatch(project);
      const po = project.path("messages/nb.po");
      // Renamed into place: the watch never sees the catalog missing, which a sync would write anew.
      execFileSync("mkfifo", [project.path("nb.fifo")]);
      renameSync(project.path("nb.fifo"), po);
      const catalog = await project.openFifoWriter("messages/nb.po");
      const exited = running.kill(signal);
      catalog.write(`# translator note\nmsgid ""\nmsgstr ""\n`);
      catalog.close();

      expect(await exited).toBe(0);
      expect(running.output().stderr).toBe(
        `messages/nb.po: CatalogUnreadable: line 1: Translator comments (#) are not supported, use inline descriptions instead:
> # translator note
  fix: keep the PO to msgctxt/msgid/msgstr with #. #: #, comments: translator comments (# ), #| and msgid_plural are not read
`
      );
    }
  );

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
    const fiber = Effect.runFork(watchInProcess(project, reporter));
    const ready = `watching ${project.root} for message changes; Ctrl-C stops\n`;
    const syncFailed =
      "SyncFailed: stdout gone\n  fix: fix the file the error names; the next change retries\n";
    try {
      await expect.poll(() => stdout, project.guard()).toBe(ready);
      expect(stderr).toBe(syncFailed);
      project.write("src/new.tsx", component("New"));
      await expect.poll(() => stderr, project.guard()).toBe(`${syncFailed}${syncFailed}`);
      project.write("src/newer.tsx", component("Newer"));
      await expect.poll(() => stdout, project.guard()).toBe(`${ready}wrote messages/nb.po\n`);
    } finally {
      await interrupt(project, fiber);
    }
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
    const fiber = Effect.runFork(watchInProcess(project, reporter));
    let exit: Exit.Exit<void, unknown>;
    try {
      await expect.poll(() => stdout, project.guard()).toContain("watching");
      expect(listeners()).toEqual(before.map((count) => count + 1));
      broken = true;
      project.write("src/new.tsx", component("New"));
      exit = await project.within(Effect.runPromise(Fiber.await(fiber)), "the watch's end");
    } finally {
      await interrupt(project, fiber);
    }

    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toEqual(new Error("stderr gone"));
    expect(listeners()).toEqual(before);
  });

  // Linux only: there a recursive watch of an unreadable directory fails as it starts, where macOS's event daemon
  // watches it all the same. Oracle: the contract by hand: the start failure is a crash (printed, exit 2), the watches
  // already started on the readable roots are closed rather than left to keep a crashed process alive, and the signal
  // listeners come off, so signals are Node's again.
  describe.skipIf(process.platform !== "linux")("a watcher that fails to start", () => {
    function lockedRoot(project: Project): void {
      project.write(
        "elmera-intl.json",
        JSON.stringify({ ...CONFIG, include: [...CONFIG.include, "zz-locked/**/*.tsx"] })
      );
      // Separate roots, watched in order: `messages` and `src` start, then `zz-locked` fails.
      mkdirSync(project.path("messages"));
      project.lock("zz-locked");
    }

    it("exits 2 on its own, its started watches closed", async ({ project }) => {
      lockedRoot(project);
      // A hang guard: a process kept alive by a leaked watch ends by SIGKILL instead.
      const child = spawn(execPath, [BIN, "extract", "--watch"], {
        cwd: project.root,
        ...project.spawnGuard(),
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (text: string) => {
        stderr += text;
      });
      const closed = await new Promise<readonly [number | null, NodeJS.Signals | null]>((done) => {
        child.on("close", (code, killedBy) => {
          done([code, killedBy]);
        });
      });

      expect(closed).toEqual([2, null]);
      expect(stderr).toMatch(/^elmera-intl failed: Error: EACCES/u);
    });

    // Unit under test: `watchProject`, as the Vite plugin starts it. Its start rejects after every watch it started is
    // closed, so a failed dev-server start leaves no handle behind.
    it("closes the watches it started when watchProject fails to start", async ({ project }) => {
      lockedRoot(project);
      const before = watches();

      await expect(watchProject(projectConfig(project), () => undefined)).rejects.toThrow(/EACCES/u);
      // A closed watch's handles are released by the event loop (on Linux, one per directory).
      await expect.poll(watches, project.guard()).toBe(before);
    });

    it("takes its signal listeners off, and closes the watches it started", async ({ project }) => {
      lockedRoot(project);
      const listeners = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
      const before = listeners();
      const opened = watches();
      const reporter = Reporter.layer({ stdout: () => undefined, stderr: () => undefined });
      const exit = await project.within(
        Effect.runPromiseExit(
          cliProgram(["extract", "--watch"], { cwd: project.root }).pipe(
            Effect.provide([CliPlatform, reporter, CatalogSync.layer(), FileEvents.layer()])
          )
        ),
        "the failed start"
      );

      expect(exitCodeOf(exit)).toBe(2);
      expect(Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : exit).toMatch(/^Error: EACCES/u);
      expect(listeners()).toEqual(before);
      // A closed watch's handles are released by the event loop (on Linux, one per directory).
      await expect.poll(watches, project.guard()).toBe(opened);
    });
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
    const ended = Effect.runPromiseExit(
      cliProgram(["extract", "--watch"], { cwd: project.root }).pipe(
        Effect.provide([CliPlatform, reporter, CatalogSync.layer(), FileEvents.layer()])
      )
    );
    try {
      await expect.poll(() => out.holding, project.guard()).toBe(true);
      // Its watchers are open (on Linux, set up per directory as the event loop runs).
      await expect.poll(watches, project.guard()).toBeGreaterThan(opened);
      sigtermCli(before);
      await expect.poll(watches, project.guard()).toBe(opened);
      expect(out.stdout).toBe("wrote messages/nb.po\n");
    } finally {
      gate.resolve();
    }
    const exit = await project.within(ended, "the watch's end");

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
    const fiber = Effect.runFork(watchInProcess(project, reporter));
    const both = "wrote messages/nb.po, messages/sv.po\n";
    const ready = `${both}watching ${project.root} for message changes; Ctrl-C stops\n`;
    try {
      await expect.poll(() => out.stdout, project.guard()).toBe(ready);
      project.write("src/middle.tsx", component("Middle"));
      await expect.poll(() => out.holding, project.guard()).toBe(true);
      project.write("src/after.tsx", component("After"));
      await expect.poll(() => project.read("messages/sv.po"), project.guard()).toContain(`msgid "After"`);
      rmSync(project.path("messages/sv.po"));
      await expect.poll(() => existsSync(project.path("messages/sv.po")), project.guard()).toBe(true);
      expect(out.stdout).toBe(ready);

      gate.resolve();
      await expect
        .poll(() => out.stdout, project.guard())
        .toBe(`${ready}${both}${both}wrote messages/sv.po\n`);
    } finally {
      await interrupt(project, fiber);
    }
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
      const ended = Effect.runPromiseExit(
        cliProgram(["extract", "--watch"], { cwd: project.root }).pipe(
          Effect.provide([CliPlatform, reporter, holding, events.layer])
        )
      );
      try {
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
      } finally {
        gate.resolve();
      }

      const exit = await project.within(ended, "the watch's end");

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
    const fiber = Effect.runFork(watchInProcess(project, reporter));
    try {
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
    } finally {
      await interrupt(project, fiber);
    }
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
    const ended = Effect.runPromiseExit(watchInProcess(project, reporter));
    await expect.poll(() => out.stdout, project.guard()).toContain("watching");
    project.write("src/new.tsx", component("New"));
    await expect.poll(() => out.holding, project.guard()).toBe(true);
    sigtermCli(before);
    gate.resolve();
    const exit = await project.within(ended, "the watch's end");

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
    const fiber = Effect.runFork(
      cliProgram(["extract", "--watch", "--poll", POLL_MS], { cwd: project.root }).pipe(
        Effect.provide([CliPlatform, reporter, recording, FileEvents.layer()])
      )
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

  // Oracle: layer 1's executable, which printed every warning of a walk before it took the signal. A walk that finds
  // 300 unreadable directories at once (moved into the tree together) reports all of them, even when the signal lands
  // as the first is printed.
  it("reports every warning of a walk the signal lands in", WALK_TEST, async ({ project }) => {
    const count = 300;
    mkdirSync(project.path("staging"));
    for (let i = 0; i < count; i += 1) {
      mkdirSync(project.path(join("staging", String(i))), { mode: 0o000 });
    }
    // Readable again before the tree is removed, wherever the move left them.
    const restore = () => {
      const parent = existsSync(project.path("src/moved-in")) ? "src/moved-in" : "staging";
      for (let i = 0; i < count; i += 1) {
        chmodSync(project.path(join(parent, String(i))), 0o755);
      }
    };
    let closed: readonly [number | null, NodeJS.Signals | null] = [null, null];
    let signalled = false;
    let stderr = "";
    try {
      const child = spawn(execPath, [BIN, "extract", "--watch", "--poll", POLL_MS], {
        cwd: project.root,
        ...project.spawnGuard(),
      });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (text: string) => {
        stdout += text;
        if (stdout.includes("watching") && !existsSync(project.path("src/moved-in"))) {
          renameSync(project.path("staging"), project.path("src/moved-in"));
        }
      });
      child.stderr.setEncoding("utf8").on("data", (text: string) => {
        stderr += text;
        if (!signalled && stderr.includes("WatchFailed")) {
          signalled = true;
          child.kill("SIGTERM");
        }
      });
      closed = await new Promise<readonly [number | null, NodeJS.Signals | null]>((done) => {
        child.on("close", (code, killedBy) => {
          done([code, killedBy]);
        });
      });
    } finally {
      restore();
    }

    expect([closed, signalled, stderr.match(/WatchFailed: cannot read/gu)?.length]).toEqual([
      [0, null],
      true,
      count,
    ]);
  });

  it("exits 0 on SIGINT", async ({ project }) => {
    const running = await startWatch(project);
    expect(await running.kill("SIGINT")).toBe(0);
  });
});
