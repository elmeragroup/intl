import { describe, expect } from "@effect/vitest";
import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { runOnceInProcess } from "../src/command-run";
import { parsePo } from "../src/po";
import type { Project } from "./project-fixture";
import { component, CONFIG, IMPORT, it, lockedRoot, POLL_MS } from "./watch-project";

// The built executable, as the CLI ships: the watch's output and signal handling are the bin's.
const BIN = fileURLToPath(new URL("../bin/elmera-intl.js", import.meta.url));
// The workspace, which a watch under Node's permission model reads its own code and dependencies from.
const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));
const HEADER = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=utf-8\\n"
"Content-Transfer-Encoding: 8bit\\n"
"Language: nb\\n"
"X-Elmera-Serializer: 1\\n"
`;

// The timeout of a test whose watch walks 300 unreadable directories, which under load outlasts the default.
const WALK_TEST = { timeout: 30_000 };

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

function translations(project: Project): ReadonlyMap<string, string> {
  const parsed = parsePo(project.read("messages/nb.po"));

  return new Map(
    parsed._tag === "Parsed" ? parsed.file.entries.map((entry) => [entry.source, entry.translation]) : []
  );
}

type Watcher = {
  /** The exit code once the watch has ended; undefined while it runs. */
  readonly exited: () => number | null | undefined;
  /** stdout from the start until the watch was live: the first sync's report and the ready line. */
  readonly startup: () => string;
  readonly output: () => { readonly stdout: string; readonly stderr: string };
  readonly kill: (signal: NodeJS.Signals) => Promise<number | null>;
};

// Resolves once the watch prints its ready line; `output()` starts after it. The watch polls, and its first walk is
// taken before its first sync, so every edit after the ready line is seen. Nothing the test did before is still
// pending then: the files it wrote are in that walk, and the first sync, which has ended, wrote the catalog as its own.
// So a test acts on a settled watch, and no sync it did not cause can overlap what it does next. The watch is killed
// at the project's deadline, and when the test ends. `node` is Node's own flags, if any.
async function startWatch(project: Project, node: ReadonlyArray<string> = []): Promise<Watcher> {
  const child: ChildProcess = spawn(execPath, [...node, BIN, "extract", "--watch", "--poll", POLL_MS], {
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
  let code: number | null | undefined;
  const closed = new Promise<number | null>((done) => {
    child.on("close", (status) => {
      code = status;
      done(status);
    });
  });
  let live = { stdout: 0, stderr: 0 };
  const watcher: Watcher = {
    exited: () => code,
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

// Unit under test: `elmera-intl extract --watch`. Oracle: the PO text written per case, by hand.
describe("extract --watch", { timeout: 20_000 }, () => {
  it("adds a new message to the PO", async ({ project }) => {
    await startWatch(project);
    project.write("src/new.tsx", component("New"));
    await expect
      .poll(() => project.read("messages/nb.po"), project.guard())
      .toContain(`msgid "New"\nmsgstr ""`);
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
    // The file and its ExtractFailed, on one line.
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

  // A config edit whose catalogs Node's permission model denies: the restart's watch fails as its trees open (its
  // existence check throws ERR_ACCESS_DENIED), which is `WatchFailed`, and the next edit starts a watch again. The
  // follow never ends on it. Oracle: 5063a1f, which reported the restart as one that did not start and kept following.
  it("reports a restart whose catalogs the permission model denies, and follows the next edit", async ({
    project,
  }) => {
    const root = realpathSync(project.root);
    const denied = realpathSync(mkdtempSync(join(tmpdir(), "elmera-intl-denied-")));
    project.defer(() => {
      rmSync(denied, { recursive: true, force: true });
    });
    const { exited, output } = await startWatch(project, [
      "--permission",
      "--no-warnings",
      // The extractor's parser is a native addon.
      "--allow-addons",
      `--allow-fs-read=${REPOSITORY}`,
      `--allow-fs-read=${root}`,
      `--allow-fs-write=${root}`,
    ]);
    project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, catalogs: join(denied, "{locale}.po") }));
    await expect
      .poll(() => exited() !== undefined || output().stderr.includes("did not start"), project.guard())
      .toBe(true);
    const failed = { exited: exited(), reported: output().stderr.includes("WatchFailed") };

    project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, locales: ["nb", "sv"] }));
    await expect
      .poll(() => exited() !== undefined || existsSync(project.path("messages/sv.po")), project.guard())
      .toBe(true);

    expect([failed, exited(), existsSync(project.path("messages/sv.po"))]).toEqual([
      { exited: undefined, reported: true },
      undefined,
      true,
    ]);
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

  // Linux only: there a recursive watch of an unreadable directory fails as it starts, where macOS's event daemon
  // watches it all the same. Oracle: the contract by hand: the start failure is a crash (printed, exit 2), the watches
  // already started on the readable roots are closed rather than left to keep a crashed process alive, and the signal
  // listeners come off, so signals are Node's again.
  describe.skipIf(process.platform !== "linux")("a watcher that fails to start", () => {
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
    // Readable again before the tree is removed, wherever the move left them: when the test ends, after the child is
    // killed (cleanups run last registered first).
    project.defer(() => {
      const parent = existsSync(project.path("src/moved-in")) ? "src/moved-in" : "staging";
      for (let i = 0; i < count; i += 1) {
        chmodSync(project.path(join(parent, String(i))), 0o755);
      }
    });
    let signalled = false;
    let stderr = "";
    const child = spawn(execPath, [BIN, "extract", "--watch", "--poll", POLL_MS], {
      cwd: project.root,
      ...project.spawnGuard(),
    });
    const ended = new Promise<readonly [number | null, NodeJS.Signals | null]>((done) => {
      child.on("close", (code, killedBy) => {
        done([code, killedBy]);
      });
    });
    project.defer(async () => {
      child.kill("SIGKILL");
      await ended;
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
    const closed = await ended;

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
