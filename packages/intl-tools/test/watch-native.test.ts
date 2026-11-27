import { describe, expect } from "@effect/vitest";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { component, it } from "./watch-project";

// The built executable, as the CLI ships.
const BIN = fileURLToPath(new URL("../bin/elmera-intl.js", import.meta.url));
const READY = "Ctrl-C stops\n";

/**
 * Whether a process holds an inotify watch on a directory, read from Linux's `/proc`: each of the process's inotify
 * descriptors (`anon_inode:inotify`) lists its watches in `/proc/<pid>/fdinfo/<fd>` as `inotify wd:… ino:<hex>
 * sdev:<hex> …`. A watch is matched by the directory's inode alone: `sdev` is the kernel's internal device number, not
 * `stat`'s encoding, and every directory the watch opens lies in the project's root, on one file system, where an inode
 * names one directory.
 *
 * @param pid - The process.
 * @param dir - The directory.
 * @returns Whether one of the process's inotify watches is on `dir`.
 */
function holdsInotifyWatch(pid: number, dir: string): boolean {
  // As bigints: an inode past 2^53 would lose precision as a number.
  const { ino } = statSync(dir, { bigint: true });
  const fds = `/proc/${pid}/fd`;

  return readdirSync(fds).some((fd) => {
    try {
      return (
        readlinkSync(`${fds}/${fd}`) === "anon_inode:inotify" &&
        readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8")
          .split("\n")
          .some((line) => {
            const hex = /^inotify .*\bino:([0-9a-f]+)\b/u.exec(line)?.[1];

            return hex !== undefined && BigInt(`0x${hex}`) === ino;
          })
      );
    } catch (error) {
      // A descriptor closed between the listing and the read holds no watch; any other failure (a /proc this process
      // may not read) is no answer, and fails the wait as itself.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  });
}

// Unit under test: `elmera-intl extract --watch` on the platform's file events (no `--poll`): the one case that proves
// a successful native update end to end (a native start that fails is covered on Linux by watch-lifecycle.test.ts and
// watch.test.ts). It proves the watch is native (an inotify watch on `src/`, which a poll never opens), writes a TSX
// source and reads the PO. Oracle: the msgid the test writes, by hand, in the PO. Linux only: on macOS fseventsd
// delivers a save seconds late or never (#33), so the native path's proof is Linux CI's inotify. The timeout is the hang
// guard of `watch.test.ts`'s spawned watches.
describe.skipIf(process.platform !== "linux")(
  "extract --watch on native file events",
  { timeout: 20_000 },
  () => {
    it("adds a new TSX source's message to the PO", async ({ project }) => {
      // A hang guard: a watch that outlives the deadline ends by SIGKILL, so its `close` always comes.
      const child = spawn(execPath, [BIN, "extract", "--watch"], {
        cwd: project.root,
        ...project.spawnGuard(),
      });
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (text: string) => {
        output += text;
      });
      child.stderr.setEncoding("utf8").on("data", (text: string) => {
        output += text;
      });
      const closed = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
        (done) => {
          child.on("close", (code, signal) => {
            done({ code, signal });
          });
        }
      );
      // The fixture removes the root after the child has stopped.
      project.defer(async () => {
        child.kill("SIGKILL");
        await closed;
      });
      // A wait that fails at once, with the CLI's exit and its output, if the CLI ends (or fails to spawn) before it
      // settles; the watch never ends on its own, so any end before the test's is a failure. A wait the end cuts short
      // keeps polling until its own guard, and its outcome is dropped. A wait that fails while the CLI runs (its
      // deadline, a sync the CLI reported failed and kept watching) carries the CLI's output too, its own error as the
      // cause.
      const whileRunning = <A>(waiting: PromiseLike<A>, what: string): Promise<A> =>
        Promise.race([
          (async () => {
            try {
              return await waiting;
            } catch (cause) {
              throw new Error(
                `the wait for ${what} failed while extract --watch ran; its output:\n${output}`,
                {
                  cause,
                }
              );
            }
          })(),
          closed.then(({ code, signal }): never => {
            throw new Error(
              `extract --watch ended while waiting for ${what} (code ${code}, signal ${signal}):\n${output}`
            );
          }),
          new Promise<never>((_resolve, reject) => {
            child.on("error", reject);
          }),
        ]);
      const ready = new Promise<void>((resolve) => {
        child.stdout.on("data", () => {
          if (output.includes(READY)) {
            resolve();
          }
        });
      });
      await whileRunning(project.within(ready, "the watch's ready line"), "its ready line");

      await whileRunning(
        expect
          .poll(() => holdsInotifyWatch(child.pid ?? 0, project.path("src")), {
            ...project.guard(),
            message: "extract --watch holds an inotify watch on src/, so it listens to native events",
          })
          .toBe(true),
        "an inotify watch on src/"
      );

      project.write("src/new.tsx", component("New"));

      await whileRunning(
        expect
          .poll(() => project.read("messages/nb.po"), project.guard())
          .toContain(`msgid "New"\nmsgstr ""`),
        "the new message in the PO"
      );
    });
  }
);
