import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { CatalogFiles } from "../src/catalog-files";
import type { OneShotCommand } from "../src/command-run";
import { oneShot } from "../src/command-run";
import { projectServices } from "../src/project-services";
import { Reporter } from "../src/reporter";
import type { Project } from "./project-fixture";
import { CONFIG, component, it, startWatch } from "./watch-project";

// A catalog path whose `..` before `{locale}` climbs out of a directory that does not exist (issue #29):
// `<root>/messages/missing/../nb.po` reads as absent while `missing/` is absent, and would reach `messages/nb.po` once
// the write created `missing/`, replacing its translations with a catalog merged from none. Unit under test: the plan
// `extract` and the watch's sync share, and `check`'s read, on Node's files in a real directory: only the kernel
// resolves `missing/..`, so no faked file system can stand in. Oracle: the contract by hand (issue #29): the run
// fails with one named problem before anything is written or created, so `nb.po`'s bytes stay and `missing/` stays
// absent.

// Runs `command` in process on the project's services on Node, its problems and summary collected.
const run = (project: Project, command: OneShotCommand) => {
  let output = "";

  return oneShot(command, { configPath: project.path("elmera-intl.json"), crash: "reject" }).pipe(
    Effect.provide([
      Reporter.layer({
        stdout: (text) => {
          output += text;
        },
        stderr: (text) => {
          output += text;
        },
      }),
      projectServices(CatalogFiles.layer()),
    ]),
    Effect.exit,
    Effect.map((exit) => ({ exit, output }))
  );
};

// The catalogs through `messages/<through>/..`, absolute, for `locales`.
const climbing = (project: Project, through: string, locales: ReadonlyArray<string>) => {
  project.write(
    "elmera-intl.json",
    JSON.stringify({ ...CONFIG, catalogs: `${project.root}/messages/${through}/../{locale}.po`, locales })
  );
};

// The project's one message extracted to `messages/nb.po` and translated by hand ("Hei"), then the config switched to
// a path through `messages/<through>/..` and a second message added. Returns nb's bytes as left.
const translated = Effect.fnUntraced(function* (
  project: Project,
  through: string,
  locales: ReadonlyArray<string> = CONFIG.locales
) {
  const { exit } = yield* run(project, "extract");
  expect(exit).toEqual(Exit.succeed("ok"));
  project.write(
    "messages/nb.po",
    project.read("messages/nb.po").replace(`msgid "Hello"\nmsgstr ""`, `msgid "Hello"\nmsgstr "Hei"`)
  );
  climbing(project, through, locales);
  project.write("src/ready.tsx", component("Ready"));

  return project.read("messages/nb.po");
});

// The problem as the CLI prints it, for the directory `missing` (shown below the root, as written).
const climbs = (missing: string) =>
  `messages/nb.po: CatalogClimbsMissing: the catalogs pattern climbs out of ${missing}, which does not exist, so what the path reaches would change once the write created it\n` +
  `  fix: create ${missing} (or, when it is a link, its target), or write "catalogs" without the ".."; a running watch syncs again on the next change to a source\n`;

// The built executable, and the workspace it loads its code from, for a run under Node's permission model.
const BIN = fileURLToPath(new URL("../bin/elmera-intl.js", import.meta.url));
const WORKSPACE = fileURLToPath(new URL("../../..", import.meta.url));

// nb's catalog with both messages, the hand-written translation kept.
const KEPT = /msgid "Hello"\nmsgstr "Hei"\n[\s\S]*msgid "Ready"\nmsgstr ""/u;

describe("a catalogs pattern that climbs out of a directory that does not exist", () => {
  // `extract` and `check` each report the one problem and change nothing; `check` reports it in place of the
  // `CatalogMissing` it reported on main, where `extract` created `missing/` and wrote an empty catalog over nb's.
  it.effect.each<{ readonly command: OneShotCommand; readonly summary: string }>([
    { command: "extract", summary: "2 messages; wrote 0 file(s)\n" },
    { command: "check", summary: "2 messages; 1 problem(s)\n" },
  ])("refuses it in $command, writing and creating nothing", ({ command, summary }, { project }) =>
    Effect.gen(function* () {
      const before = yield* translated(project, "missing");
      const { exit, output } = yield* run(project, command);

      expect({
        exit,
        output,
        nb: project.read("messages/nb.po"),
        missing: existsSync(project.path("messages/missing")),
      }).toEqual({
        exit: Exit.succeed("problems"),
        output: `${climbs("messages/missing")}${summary}`,
        nb: before,
        missing: false,
      });
    })
  );

  // A dangling link is a component that does not resolve: the write's `mkdir` would fail on it, but creating its target
  // (`messages/nowhere`) would make the path reach `messages/nb.po` all the same. The link stays a link, its target
  // absent.
  it.effect("refuses it through a dangling link", ({ project }) =>
    Effect.gen(function* () {
      const before = yield* translated(project, "jump");
      symlinkSync("nowhere", project.path("messages/jump"));
      const { exit, output } = yield* run(project, "extract");

      expect({
        exit,
        output,
        nb: project.read("messages/nb.po"),
        link: lstatSync(project.path("messages/jump")).isSymbolicLink(),
        target: existsSync(project.path("messages/nowhere")),
      }).toEqual({
        exit: Exit.succeed("problems"),
        output: `${climbs("messages/jump")}2 messages; wrote 0 file(s)\n`,
        nb: before,
        link: true,
        target: false,
      });
    })
  );

  // The directory is named as the path spells it: through `jump -> ../storage/sub`, `jump/../fresh` is `storage/fresh`,
  // where the lexical `messages/fresh` would send the developer to create the wrong one. Neither is created.
  it.effect("names the missing directory as the path spells it", ({ project }) =>
    Effect.gen(function* () {
      const before = yield* translated(project, "jump/../fresh");
      mkdirSync(project.path("storage/sub"), { recursive: true });
      symlinkSync("../storage/sub", project.path("messages/jump"));
      const { exit, output } = yield* run(project, "extract");

      expect({
        exit,
        output,
        nb: project.read("messages/nb.po"),
        created: [existsSync(project.path("storage/fresh")), existsSync(project.path("messages/fresh"))],
      }).toEqual({
        exit: Exit.succeed("problems"),
        output: `${climbs("messages/jump/../fresh")}2 messages; wrote 0 file(s)\n`,
        nb: before,
        created: [false, false],
      });
    })
  );

  // Under Node's permission model, granted reads of the project and the workspace alone, a pattern whose every component
  // exists checks as with no `..`: the walk asks about no directory above the project. Oracle: what `check` reports on
  // main for this tree (`CatalogMissing`, exit 1), as the built executable runs it.
  it.effect(
    "checks a pattern through existing directories with reads granted for the project alone",
    ({ project }) =>
      Effect.sync(() => {
        mkdirSync(project.path("messages/present"), { recursive: true });
        climbing(project, "present", ["nb"]);
        const ran = spawnSync(
          execPath,
          [
            "--permission",
            "--allow-addons",
            `--allow-fs-read=${project.root}`,
            `--allow-fs-read=${realpathSync(project.root)}`,
            `--allow-fs-read=${WORKSPACE}`,
            BIN,
            "check",
            "--config",
            project.path("elmera-intl.json"),
          ],
          { cwd: project.root, encoding: "utf8", ...project.spawnGuard() }
        );

        expect({ code: ran.status, stdout: ran.stdout, problem: ran.stderr.split("\n").slice(-3) }).toEqual({
          code: 1,
          stdout: "1 messages; 1 problem(s)\n",
          problem: [
            "messages/nb.po: CatalogMissing: messages/nb.po does not exist",
            "  fix: run `elmera-intl extract`",
            "",
          ],
        });
      }),
    { timeout: 20_000 }
  );

  // Every component before the `..` exists, so each path reaches at the read what it reaches at the write: sv's
  // catalog, absent, is created through it, and nb's is merged, its translation kept.
  it.effect("syncs a pattern whose every component before the `..` exists", ({ project }) =>
    Effect.gen(function* () {
      yield* translated(project, "present", ["sv", "nb"]);
      mkdirSync(project.path("messages/present"));
      const { exit, output } = yield* run(project, "extract");

      expect({ exit, output }).toEqual({ exit: Exit.succeed("ok"), output: "2 messages; wrote 2 file(s)\n" });
      expect(project.read("messages/sv.po")).toMatch(/"Language: sv\\n"[\s\S]*msgid "Ready"/u);
      expect(project.read("messages/nb.po")).toMatch(KEPT);
    })
  );
});

describe("the watch on a catalogs pattern that climbs out of a directory that does not exist", () => {
  // The watch's sync fails with the same problem and writes nothing. Creating the directory the problem names is no
  // change the watch syncs on (it is neither a source nor a configured catalog path): five debounces later, still the
  // one failed sync. The next change to a source syncs, through the path that now reaches `messages/nb.po`, keeping
  // its translation. Oracle: the problem's code by hand, nb's bytes and `missing/` absent after the failed sync, the
  // count of the watch's reports, and the translation kept by the sync that recovers.
  it.effect("reports it, then syncs on the next source change once the directory exists", ({ project }) =>
    Effect.gen(function* () {
      const before = yield* translated(project, "missing");
      const { reports, results } = yield* startWatch(project);

      expect({
        reports: [...reports],
        problems: results[0]?._tag === "Failed" ? results[0].problems.map(({ code }) => code) : [],
        nb: project.read("messages/nb.po"),
        missing: existsSync(project.path("messages/missing")),
      }).toEqual({ reports: ["Failed"], problems: ["CatalogClimbsMissing"], nb: before, missing: false });

      mkdirSync(project.path("messages/missing"));
      for (let debounce = 0; debounce < 5; debounce += 1) {
        yield* TestClock.adjust("1 second");
      }
      const created = [...reports];

      project.write("src/later.tsx", component("Later"));
      yield* TestClock.adjust("1 second");

      expect({ created, saved: reports }).toEqual({
        created: ["Failed"],
        saved: ["Failed", "Written"],
      });
      expect(project.read("messages/nb.po")).toMatch(/msgid "Hello"\nmsgstr "Hei"\n[\s\S]*msgid "Later"/u);
    })
  );
});
