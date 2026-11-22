import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliPlatform, cliProgram, runCli } from "../src/cli-run";
import { extractCatalogs, planCatalogs, writeCatalogs } from "../src/commands";
import { parsePo } from "../src/po";
import { loadConfig } from "../src/project-config";
import { Reporter } from "../src/reporter";
import type { ProjectWatcher, WatchMode } from "../src/watch";
import { watchProject } from "../src/watch";

// The built executable, as the CLI ships: the watch's output and signal handling are the bin's.
const BIN = fileURLToPath(new URL("../bin/elmera-intl.js", import.meta.url));
const CONFIG = { include: ["src/**/*.{ts,tsx}"], catalogs: "messages/{locale}.po", locales: ["nb"] };
const IMPORT = `import { T } from "@elmeragroup/intl/react";\n`;
const HEADER = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=utf-8\\n"
"Content-Transfer-Encoding: 8bit\\n"
"Language: nb\\n"
"X-Elmera-Serializer: 1\\n"
`;

// Every watch here polls: a stat of each watched file every 50 ms sees an edit whatever the host's file events do
// (macOS delivers them through fseventsd, which a busy host delays by seconds or drops), so each wait below ends on
// the edit, not on the event daemon. `--poll` and `watchProject`'s mode are the same seam the CLI and the Vite plugin
// expose to such hosts; the native events stay the default, and the e2e dev loop runs on them.
const POLL_MS = "50";
const POLLING: WatchMode = { _tag: "poll", intervalMs: Number(POLL_MS) };
// A hang guard, not a timing assertion: a spawned watcher's first sync and a 300-file rescan outlast poll's 1 s default.
const HANG_GUARD = { timeout: 15_000 };
const PROBE = { ...HANG_GUARD, interval: 500 };
const PROBE_FILE = "src/probe.tsx";

let root = "";
let watcher: Watcher | undefined;
let inProcess: ProjectWatcher | undefined;
// Directories a test made unreadable, restored before the temp tree is removed.
let locked: Array<string> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "elmera-intl-watch-"));
  write("elmera-intl.json", JSON.stringify(CONFIG));
  write("src/page.tsx", component("Hello"));
});

afterEach(async () => {
  await watcher?.kill("SIGKILL");
  watcher = undefined;
  await inProcess?.close();
  inProcess = undefined;
  locked.forEach((dir) => {
    chmodSync(dir, 0o755);
  });
  locked = [];
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function component(text: string): string {
  return `${IMPORT}export const C = () => <T>${text}</T>;\n`;
}

// One-shot extract, then a msgstr for each pair.
async function extractTranslated(pairs: ReadonlyArray<readonly [string, string]>): Promise<void> {
  const io = { cwd: root, stdout: () => undefined, stderr: () => undefined };
  expect(await runCli(["extract"], io)).toBe(0);
  let po = read("messages/nb.po");
  for (const [source, translation] of pairs) {
    po = po.replace(`msgid "${source}"\nmsgstr ""`, `msgid "${source}"\nmsgstr "${translation}"`);
  }
  write("messages/nb.po", po);
}

function translations(): ReadonlyMap<string, string> {
  const parsed = parsePo(read("messages/nb.po"));

  return new Map(
    parsed._tag === "Parsed" ? parsed.file.entries.map((entry) => [entry.source, entry.translation]) : []
  );
}

type Watcher = {
  /** stdout from the start until the watch was live: the first sync's report and the ready line. */
  readonly startup: () => string;
  readonly output: () => { readonly stdout: string; readonly stderr: string };
  readonly kill: (signal: NodeJS.Signals) => Promise<number | null>;
};

// Resolves once a sync shows the watch is live, so later edits and signals reach it. The ready line prints when
// fs.watch returns, but a recursive watch misses an edit made before its stream starts (seen under load: an edit right
// after it never synced). The probe is a syntax error, so its syncs write nothing; `output()` starts after them.
async function startWatch(): Promise<Watcher> {
  const child: ChildProcess = spawn(execPath, [BIN, "extract", "--watch", "--poll", POLL_MS], {
    cwd: root,
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
  watcher = {
    startup: () => stdout.slice(0, live.stdout),
    output: () => ({ stdout: stdout.slice(live.stdout), stderr: stderr.slice(live.stderr) }),
    kill: (signal) => {
      child.kill(signal);

      return closed;
    },
  };
  await expect.poll(() => stdout, HANG_GUARD).toContain("watching");
  // Rewritten only until reported: a rewrite after the report would queue another probe sync.
  await expect
    .poll(() => {
      if (!stderr.includes(PROBE_FILE)) {
        write(PROBE_FILE, `${IMPORT}export const C = () => <T>Probe</T;\n`);
      }

      return stderr;
    }, PROBE)
    .toContain(PROBE_FILE);
  unlinkSync(join(root, PROBE_FILE));
  live = { stdout: stdout.length, stderr: stderr.length };

  return watcher;
}

// Unit under test: `elmera-intl extract --watch`. Oracle: the PO text written per case, by hand.
describe("extract --watch", { timeout: 20_000 }, () => {
  it("adds a new message to the PO", async () => {
    await startWatch();
    write("src/new.tsx", component("New"));
    await expect.poll(() => read("messages/nb.po"), HANG_GUARD).toContain(`msgid "New"\nmsgstr ""`);
  });

  it("keeps a msgstr saved right after the sync that added its message", async () => {
    const loaded = loadConfig(join(root, "elmera-intl.json"));

    if (loaded._tag !== "Config") {
      throw new Error(loaded.problem.message);
    }

    const po = join(root, "messages/nb.po");
    let saved = false;
    inProcess = watchProject(
      loaded.config,
      () => undefined,
      (config, options) => {
        const result = extractCatalogs(config, options);
        const added = result.written.find(({ path, text }) => path === po && text.includes(`msgid "Ready"`));

        // The save lands after the sync's writes, before the watch returns to the event loop.
        if (!saved && added !== undefined) {
          saved = true;
          write(
            "messages/nb.po",
            added.text.replace(`msgid "Ready"\nmsgstr ""`, `msgid "Ready"\nmsgstr "Klar"`)
          );
        }

        return result;
      },
      POLLING
    );
    // The watch has no ready signal, so the trigger is rewritten until the watch syncs it. It stops once the PO has the
    // message: one more source event would sync again and compile the edit whether or not the watch saw it.
    await expect
      .poll(() => {
        if (!read("messages/nb.po").includes(`msgid "Ready"`)) {
          write("src/ready.tsx", component("Ready"));
        }

        return read("messages/nb.po");
      }, PROBE)
      .toContain(`msgid "Ready"\nmsgstr "Klar"`);
    // A sync after the save, which must merge it rather than write the PO it read before.
    write("src/after.tsx", component("After"));
    await expect.poll(() => read("messages/nb.po"), HANG_GUARD).toContain(`msgid "After"`);

    expect(read("messages/nb.po")).toContain(`msgid "Ready"\nmsgstr "Klar"`);
  });

  it("keeps a msgstr saved while a sync runs", async () => {
    const loaded = loadConfig(join(root, "elmera-intl.json"));

    if (loaded._tag !== "Config") {
      throw new Error(loaded.problem.message);
    }

    const po = join(root, "messages/nb.po");
    let saved = false;
    inProcess = watchProject(
      loaded.config,
      () => undefined,
      (config, options) => {
        const plan = planCatalogs(config, options);

        // The save lands after the sync read the PO and before it writes.
        if (!saved && plan.outputs.some(({ path, text }) => path === po && text.includes(`msgid "Ready"`))) {
          saved = true;
          write(
            "messages/nb.po",
            read("messages/nb.po").replace(`msgid "Hello"\nmsgstr ""`, `msgid "Hello"\nmsgstr "Hei"`)
          );
        }

        return writeCatalogs(plan, options);
      },
      POLLING
    );
    // The watch has no ready signal, so the trigger is rewritten until a sync writes it.
    await expect
      .poll(() => {
        if (!read("messages/nb.po").includes(`msgid "Ready"`)) {
          write("src/ready.tsx", component("Ready"));
        }

        return read("messages/nb.po");
      }, PROBE)
      .toContain(`msgid "Ready"`);
    await expect.poll(() => read("messages/nb.po"), HANG_GUARD).toContain(`msgid "Hello"\nmsgstr "Hei"`);
  });

  // An unreadable directory stands in for one the poll must never read: reading it would fail, and the failure would
  // be reported. Oracle: the contract per case, by hand: a directory the config excludes, and node_modules, are pruned
  // before the poll descends; any other unreadable directory is reported once, and the rest of the tree still syncs.
  describe("polling a tree with unreadable directories", () => {
    function lock(path: string): void {
      mkdirSync(join(root, path), { recursive: true });
      write(`${path}/inside.tsx`, component("Hidden"));
      chmodSync(join(root, path), 0o000);
      locked.push(join(root, path));
    }

    function watchPolling(): Array<string> {
      const loaded = loadConfig(join(root, "elmera-intl.json"));

      if (loaded._tag !== "Config") {
        throw new Error(loaded.problem.message);
      }

      const reported: Array<string> = [];
      inProcess = watchProject(
        loaded.config,
        (result) => {
          if (result._tag === "Failed") {
            reported.push(...result.problems.map((problem) => `${problem.code}: ${problem.message}`));
          }
        },
        extractCatalogs,
        POLLING
      );

      return reported;
    }

    it("never reads an excluded directory or node_modules, and syncs the rest", async () => {
      write(
        "elmera-intl.json",
        JSON.stringify({ ...CONFIG, include: ["**/*.tsx"], exclude: ["src/private"] })
      );
      lock("src/private");
      lock("node_modules/some-package");
      const reported = watchPolling();
      await expect.poll(() => read("messages/nb.po"), HANG_GUARD).toContain(`msgid "Hello"`);

      write("src/page.tsx", component("Edited"));
      await expect.poll(() => read("messages/nb.po"), HANG_GUARD).toContain(`msgid "Edited"`);
      expect(reported).toEqual([]);
    });

    it("reports an unreadable directory once, and syncs the rest of the tree", async () => {
      lock("src/locked");
      const reported = watchPolling();

      write("src/page.tsx", component("Edited"));
      await expect.poll(() => read("messages/nb.po"), HANG_GUARD).toContain(`msgid "Edited"`);
      write("src/page.tsx", component("Edited again"));
      await expect.poll(() => read("messages/nb.po"), HANG_GUARD).toContain(`msgid "Edited again"`);
      expect(reported.filter((problem) => problem.startsWith("WatchFailed"))).toEqual([
        expect.stringContaining(join(root, "src/locked")),
      ]);
    });
  });

  it("keeps a deleted message's entry and translation", async () => {
    await extractTranslated([["Hello", "Hei"]]);
    await startWatch();
    // The added message is the signal that the sync after the deletion ran.
    write("src/other.tsx", component("Other"));
    unlinkSync(join(root, "src/page.tsx"));
    await expect.poll(() => read("messages/nb.po"), HANG_GUARD).toContain(`msgid "Other"`);

    expect(read("messages/nb.po")).toBe(`${HEADER}
#: src/page.tsx
msgid "Hello"
msgstr "Hei"

#: src/other.tsx
msgid "Other"
msgstr ""
`);
  });

  it("prints a syntax error, leaves the catalog byte-identical, and resumes once the file is fixed", async () => {
    await extractTranslated([["Hello", "Hei"]]);
    const po = read("messages/nb.po");
    const { output } = await startWatch();
    write("src/broken.tsx", `${IMPORT}export const C = () => <T>Broken</T;\n`);
    // One line: a late probe report also says ExtractFailed.
    await expect.poll(() => output().stderr, HANG_GUARD).toMatch(/src\/broken\.tsx[^\n]*: ExtractFailed:/u);

    expect(read("messages/nb.po")).toBe(po);

    write("src/broken.tsx", component("Fixed"));
    await expect.poll(() => read("messages/nb.po"), HANG_GUARD).toContain(`msgid "Fixed"`);
  });

  it("ends a 300-file burst with every new message and every existing translation", async () => {
    const files = Array.from({ length: 300 }, (_, i) => i);
    files.forEach((i) => {
      write(`src/gen/f${i}.tsx`, component(`Message ${i}`));
    });
    await extractTranslated(files.map((i) => [`Message ${i}`, `Melding ${i}`]));
    await startWatch();
    // A branch switch: every file rewritten at once.
    files.forEach((i) => {
      write(`src/gen/f${i}.tsx`, component(`Message ${i} v2`));
    });

    const expected = new Map<string, string>([
      ["Hello", ""],
      ...files.flatMap((i): ReadonlyArray<readonly [string, string]> => [
        [`Message ${i}`, `Melding ${i}`],
        [`Message ${i} v2`, ""],
      ]),
    ]);
    await expect.poll(translations, HANG_GUARD).toEqual(expected);
  });

  it("syncs a file added under a ./-prefixed include pattern", async () => {
    write("elmera-intl.json", JSON.stringify({ ...CONFIG, include: ["./src/**/*.{ts,tsx}"] }));
    await startWatch();
    write("src/new.tsx", component("New"));
    await expect.poll(() => read("messages/nb.po"), HANG_GUARD).toContain(`#: src/new.tsx\nmsgid "New"`);
  });

  it("ignores a save under an excluded directory", async () => {
    write("elmera-intl.json", JSON.stringify({ ...CONFIG, exclude: ["src/skip"] }));
    await startWatch();
    write("src/skip/draft.tsx", component("Draft"));
    // The included save is the signal that a sync after the excluded one ran.
    write("src/new.tsx", component("New"));
    await expect.poll(() => read("messages/nb.po"), HANG_GUARD).toContain(`msgid "New"`);

    expect(read("messages/nb.po")).not.toContain("Draft");
  });

  it("syncs a populated directory moved into an include root", async () => {
    write("staging/feature/a.tsx", component("Moved in"));
    await startWatch();
    renameSync(join(root, "staging/feature"), join(root, "src/feature"));
    await expect
      .poll(() => read("messages/nb.po"), HANG_GUARD)
      .toContain(`#: src/feature/a.tsx\nmsgid "Moved in"`);
  });

  it("keeps a moved-out directory's entries while syncing the one moved in", async () => {
    write("src/old/a.tsx", component("Moved out"));
    write("staging/new/b.tsx", component("Moved in"));
    await extractTranslated([["Moved out", "Flyttet ut"]]);
    await startWatch();
    renameSync(join(root, "src/old"), join(root, "staging/old"));
    renameSync(join(root, "staging/new"), join(root, "src/new"));
    await expect.poll(translations, HANG_GUARD).toEqual(
      new Map([
        ["Hello", ""],
        ["Moved out", "Flyttet ut"],
        ["Moved in", ""],
      ])
    );
  });

  it("reports a sync that throws and keeps watching", async () => {
    const { output } = await startWatch();
    // A directory where the PO goes: reading it throws, an I/O failure the CLI does not classify.
    rmSync(join(root, "messages/nb.po"));
    mkdirSync(join(root, "messages/nb.po"));
    write("src/first.tsx", component("First"));
    await expect.poll(() => output().stderr, HANG_GUARD).toContain("SyncFailed");

    rmSync(join(root, "messages/nb.po"), { recursive: true });
    write("src/second.tsx", component("Second"));
    await expect.poll(() => read("messages/nb.po"), HANG_GUARD).toContain(`msgid "Second"`);
  });

  // Oracle: the report lines, written out by hand: the first sync's catalogs, then the ready line naming the project
  // root, then each later sync's catalogs, relative to the root.
  it("prints what each sync writes, and the ready line after the first", async () => {
    const running = await startWatch();
    write("src/new.tsx", component("New"));
    await expect.poll(() => running.output().stdout, HANG_GUARD).toBe("wrote messages/nb.po\n");

    expect(running.startup()).toBe(
      `wrote messages/nb.po\nwatching ${realpathSync(root)} for message changes; Ctrl-C stops\n`
    );
  });

  // Unit under test: the watch reporting through a Reporter whose writes complete later, as a host's may (layer 4's
  // Vite logger). Oracle: the executable's lines, written out by hand: the first sync's catalogs, the ready line, then
  // each later sync's catalogs.
  it("reports through an asynchronous Reporter", async () => {
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
    const fiber = Effect.runFork(
      cliProgram(["extract", "--watch", "--poll", POLL_MS], { cwd: root, host: "executable" }).pipe(
        Effect.provide(Layer.merge(CliPlatform, reporter))
      )
    );
    const ready = `wrote messages/nb.po\nwatching ${root} for message changes; Ctrl-C stops\n`;
    try {
      await expect.poll(() => stdout, HANG_GUARD).toContain("watching");
      expect(stdout).toBe(ready);
      write("src/new.tsx", component("New"));
      await expect.poll(() => stdout, HANG_GUARD).toBe(`${ready}wrote messages/nb.po\n`);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }

    expect(stderr).toBe("");
  });

  // A signal that lands while a sync runs ends the watch after that sync, whose result is still reported. Oracle: the
  // layer 1 executable's stderr for this case, written out by hand, and its exit 0. The catalog becomes a FIFO the next
  // sync blocks reading (the writer's open resolves once it does), so the signal lands mid-sync without timing.
  it.each(["SIGINT", "SIGTERM"] as const)("reports the sync a %s lands in, then exits 0", async (signal) => {
    await extractTranslated([]);
    const running = await startWatch();
    const po = join(root, "messages/nb.po");
    // Renamed into place: the watch never sees the catalog missing, which a sync would write anew.
    execFileSync("mkfifo", [join(root, "nb.fifo")]);
    renameSync(join(root, "nb.fifo"), po);
    const catalog = await open(po, "w");
    const exited = running.kill(signal);
    await catalog.write(`# translator note\nmsgid ""\nmsgstr ""\n`);
    await catalog.close();

    expect(await exited).toBe(0);
    expect(running.output().stderr).toBe(
      `messages/nb.po: CatalogUnreadable: line 1: Translator comments (#) are not supported, use inline descriptions instead:
> # translator note
  fix: keep the PO to msgctxt/msgid/msgstr with #. #: #, comments: translator comments (# ), #| and msgid_plural are not read
`
    );
  });

  // Unit under test: the watch's reporting when a Reporter write throws, as a host's may (layer 4). Oracle: layer 1's
  // handling, written out by hand: each failed write is reported as its sync's SyncFailed, before the ready line and
  // after it, and the watch goes on.
  it("reports a write that throws as SyncFailed, and keeps watching", async () => {
    let stdout = "";
    let stderr = "";
    // The first sync's write fails, and so does the first after the ready line.
    let failures = 2;
    const reporter = Layer.succeed(Reporter, {
      stdout: Effect.fnUntraced(function* (text: string) {
        yield* Effect.sync(() => {
          if (failures > 0 && text.startsWith("wrote")) {
            failures -= 1;
            throw new Error("stdout gone");
          }

          stdout += text;
        });
      }),
      stderr: Effect.fnUntraced(function* (text: string) {
        yield* Effect.sync(() => {
          stderr += text;
        });
      }),
    });
    const fiber = Effect.runFork(
      cliProgram(["extract", "--watch", "--poll", POLL_MS], { cwd: root, host: "executable" }).pipe(
        Effect.provide(Layer.merge(CliPlatform, reporter))
      )
    );
    const ready = `watching ${root} for message changes; Ctrl-C stops\n`;
    const syncFailed =
      "SyncFailed: stdout gone\n  fix: fix the file the error names; the next change retries\n";
    try {
      await expect.poll(() => stdout, HANG_GUARD).toBe(ready);
      expect(stderr).toBe(syncFailed);
      write("src/new.tsx", component("New"));
      await expect.poll(() => stderr, HANG_GUARD).toBe(`${syncFailed}${syncFailed}`);
      write("src/newer.tsx", component("Newer"));
      await expect.poll(() => stdout, HANG_GUARD).toBe(`${ready}wrote messages/nb.po\n`);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  // When the SyncFailed report cannot be written either, nothing reports the watch any more: it must end with that
  // failure, its watcher closed and its signal listeners gone, rather than go on writing catalogs unreported.
  it("ends when a failed write cannot be reported either", async () => {
    let stdout = "";
    let broken = false;
    const failing = (append: (text: string) => void, error: string) => (text: string) =>
      Effect.sync(() => {
        if (broken) {
          throw new Error(error);
        }

        append(text);
      });
    const reporter = Layer.succeed(Reporter, {
      stdout: failing((text) => {
        stdout += text;
      }, "stdout gone"),
      stderr: failing(() => undefined, "stderr gone"),
    });
    const listeners = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const before = listeners();
    const ended = Effect.runPromiseExit(
      cliProgram(["extract", "--watch", "--poll", POLL_MS], { cwd: root, host: "executable" }).pipe(
        Effect.provide(Layer.merge(CliPlatform, reporter))
      )
    );
    await expect.poll(() => stdout, HANG_GUARD).toContain("watching");
    expect(listeners()).toEqual(before.map((count) => count + 1));
    broken = true;
    write("src/new.tsx", component("New"));
    const exit = await ended;

    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toEqual(new Error("stderr gone"));
    expect(listeners()).toEqual(before);
  });

  // Linux only: there a recursive watch of an unreadable directory fails as it starts, where macOS's event daemon
  // watches it all the same. Oracle: Node's default for a signal no listener takes, death by that signal, after the
  // start failure printed as a crash; the watches started on the readable roots keep the process alive until then.
  describe.skipIf(process.platform !== "linux")("a watcher that fails to start", () => {
    it.each(["SIGINT", "SIGTERM"] as const)("leaves %s to Node's default", async (signal) => {
      write(
        "elmera-intl.json",
        JSON.stringify({ ...CONFIG, include: [...CONFIG.include, "zz-locked/**/*.tsx"] })
      );
      // Separate roots, watched in order: `messages` and `src` start, then `zz-locked` fails.
      mkdirSync(join(root, "messages"));
      mkdirSync(join(root, "zz-locked"));
      chmodSync(join(root, "zz-locked"), 0o000);
      locked.push(join(root, "zz-locked"));
      const child = spawn(execPath, [BIN, "extract", "--watch"], {
        cwd: root,
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (text: string) => {
        stderr += text;
      });
      const closed = new Promise<readonly [number | null, NodeJS.Signals | null]>((done) => {
        child.on("close", (code, killedBy) => {
          done([code, killedBy]);
        });
      });
      await expect.poll(() => stderr, HANG_GUARD).toMatch(/^elmera-intl failed: Error: EACCES/u);
      child.kill(signal);

      expect(await closed).toEqual([null, signal]);
    });
  });

  it("exits 0 on SIGINT", async () => {
    const running = await startWatch();
    expect(await running.kill("SIGINT")).toBe(0);
  });
});
