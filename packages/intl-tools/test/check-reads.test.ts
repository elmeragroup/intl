import { describe, expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { rmSync } from "node:fs";

import { CatalogFiles } from "../src/catalog-files";
import type { OneShotCommand } from "../src/command-run";
import { oneShot } from "../src/command-run";
import { Reporter } from "../src/reporter";
import type { Project } from "./project-fixture";
import { it } from "./watch-project";

// `check` reads each PO where its rules read it and again where it compiles it, as the loaders will read it: a PO
// removed or replaced in between is judged as it is at the compile. Unit under test: `oneShot("check")`, the in-process
// run the hosts share, on Node's catalog files with a hook after the first read of nb. Oracle: the layer 4 check, by
// hand (62bfdb1): a PO removed after its first read crashes with the read's ENOENT; a malformed one swapped in is a
// CatalogInvalid problem.
describe("check reads each catalog again to compile it", () => {
  // Extracts the seeded project and translates its one message, so check passes as it stands.
  const synced = Effect.fnUntraced(function* (project: Project) {
    yield* run(project, "extract", CatalogFiles.layer());
    project.write(
      "messages/nb.po",
      project.read("messages/nb.po").replace(`msgid "Hello"\nmsgstr ""`, `msgid "Hello"\nmsgstr "Hei"`)
    );
  });

  // Runs `command` on `files`, with the problems and summary collected.
  const run = (project: Project, command: OneShotCommand, files: Layer.Layer<CatalogFiles>) => {
    let output = "";

    return oneShot(command, {
      configPath: project.path("elmera-intl.json"),
      crash: "reject",
    }).pipe(
      Effect.provide([
        Reporter.layer({
          stdout: (text) => {
            output += text;
          },
          stderr: (text) => {
            output += text;
          },
        }),
        files,
      ]),
      Effect.exit,
      Effect.map((exit) => ({ exit, output }))
    );
  };

  // Node's catalog files, running `after` once, right after the first read of nb.
  const afterFirstRead = (project: Project, after: () => void): Layer.Layer<CatalogFiles> => {
    const nb = project.path("messages/nb.po");
    let done = false;

    return Layer.effect(
      CatalogFiles,
      CatalogFiles.use((live) =>
        Effect.succeed({
          ...live,
          read: (path: string) =>
            live.read(path).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (!done && path === nb) {
                    done = true;
                    after();
                  }
                })
              )
            ),
        })
      )
    ).pipe(Layer.provide(CatalogFiles.layer()));
  };

  it.effect("crashes on a PO removed after its first read", ({ project }) =>
    Effect.gen(function* () {
      yield* synced(project);
      const { exit } = yield* run(
        project,
        "check",
        afterFirstRead(project, () => {
          rmSync(project.path("messages/nb.po"));
        })
      );

      expect(Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : exit).toMatch(/^Error: ENOENT/u);
    })
  );

  it.effect("reports a malformed PO swapped in after its first read", ({ project }) =>
    Effect.gen(function* () {
      yield* synced(project);
      const { exit, output } = yield* run(
        project,
        "check",
        afterFirstRead(project, () => {
          project.write("messages/nb.po", `${project.read("messages/nb.po")}msgid "Broken\n`);
        })
      );

      expect(output).toContain("CatalogInvalid");
      expect(exit).toEqual(Exit.succeed("problems"));
    })
  );
});
