import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli-run";
import { extractCatalogs, planCatalogs, writeCatalogs } from "../src/commands";
import { parsePo } from "../src/po";
import { loadConfig } from "../src/project";
import type { ProjectWatcher } from "../src/watch";
import { watchProject } from "../src/watch";
import { cliFromSource } from "./cli-source";

const CONFIG = { include: ["src/**/*.{ts,tsx}"], catalogs: "messages/{locale}.po", locales: ["nb"] };
const IMPORT = `import { T } from "@elmeragroup/intl/react";\n`;
const HEADER = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=utf-8\\n"
"Content-Transfer-Encoding: 8bit\\n"
"Language: nb\\n"
"X-Elmera-Serializer: 1\\n"
`;

// A hang guard, not a timing assertion: a spawned watcher's first sync and a 300-file rescan outlast poll's 1 s default.
const HANG_GUARD = { timeout: 15_000 };
const PROBE = { ...HANG_GUARD, interval: 500 };
const PROBE_FILE = "src/probe.tsx";

let root = "";
let watcher: Watcher | undefined;
let inProcess: ProjectWatcher | undefined;

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
function extractTranslated(translations: ReadonlyArray<readonly [string, string]>): void {
  const io = { cwd: root, stdout: () => undefined, stderr: () => undefined };
  expect(runCli(["extract"], io)).toBe(0);
  let po = read("messages/nb.po");
  for (const [source, translation] of translations) {
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
  readonly output: () => { readonly stdout: string; readonly stderr: string };
  readonly kill: (signal: NodeJS.Signals) => Promise<number | null>;
};

// Resolves once a sync shows the watch is live, so later edits and signals reach it. The ready line prints when
// fs.watch returns, but a recursive watch misses an edit made before its stream starts (seen under load: an edit right
// after it never synced). The probe is a syntax error, so its syncs write nothing; `output()` starts after them.
async function startWatch(): Promise<Watcher> {
  const child: ChildProcess = spawn(execPath, cliFromSource("extract", "--watch"), { cwd: root });
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
      }
    );
    // fs.watch has no ready signal, so the trigger is rewritten until the watch syncs it. It stops once the PO has the
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
      }
    );
    // fs.watch has no ready signal, so the trigger is rewritten until a sync writes it.
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

  it("keeps a deleted message's entry and translation", async () => {
    extractTranslated([["Hello", "Hei"]]);
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
    extractTranslated([["Hello", "Hei"]]);
    const po = read("messages/nb.po");
    const { output } = await startWatch();
    write("src/broken.tsx", `${IMPORT}export const C = () => <T>Broken</T;\n`);
    // One line: a late probe report also says ExtractFailed.
    await expect.poll(() => output().stderr, HANG_GUARD).toMatch(/src\/broken\.tsx[^\n]*: ExtractFailed:/);

    expect(read("messages/nb.po")).toBe(po);

    write("src/broken.tsx", component("Fixed"));
    await expect.poll(() => read("messages/nb.po"), HANG_GUARD).toContain(`msgid "Fixed"`);
  });

  it("ends a 300-file burst with every new message and every existing translation", async () => {
    const files = Array.from({ length: 300 }, (_, i) => i);
    files.forEach((i) => {
      write(`src/gen/f${i}.tsx`, component(`Message ${i}`));
    });
    extractTranslated(files.map((i) => [`Message ${i}`, `Melding ${i}`]));
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
    extractTranslated([["Moved out", "Flyttet ut"]]);
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

  it.each([
    ["check", ["check", "--watch"]],
    ["--json", ["extract", "--watch", "--json"]],
  ])("exits 2 with usage for --watch with %s instead of watching", (_label, args) => {
    // The timeout is a hang guard: a CLI that starts watching never exits on its own.
    const run = spawnSync(execPath, cliFromSource(...args), { cwd: root, encoding: "utf8", timeout: 10_000 });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("usage: elmera-intl");
  });

  it("exits 0 on SIGINT", async () => {
    const running = await startWatch();
    expect(await running.kill("SIGINT")).toBe(0);
  });
});
