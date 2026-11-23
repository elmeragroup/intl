import { describe, expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { rmSync } from "node:fs";

import { CatalogFiles } from "../src/catalog-files";
import type { OneShotCommand } from "../src/command-run";
import { oneShot } from "../src/command-run";
import { projectServices } from "../src/project-services";
import { Reporter } from "../src/reporter";
import type { Project } from "./project-fixture";
import { it } from "./watch-project";

// `check` reads each PO where its rules read it and again for each compile (its locale's, and the English pass from
// the first locale's), as the loaders will read it: a PO removed or replaced in between is judged as it is at the
// compile. Unit under test: `oneShot("check")`, the in-process run the hosts share, on the project's services on Node
// with a hook after one read of nb. Oracle: the layer 4 check, by hand (62bfdb1): a PO removed after its first read, or after the
// Norwegian compile's, crashes with the next read's ENOENT; a malformed one swapped in is a CatalogInvalid problem
// (the English pass's, after the Norwegian compile).
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
  const run = (
    project: Project,
    command: OneShotCommand,
    files: Layer.Layer<CatalogFiles, never, FileSystem.FileSystem>
  ) => {
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
        projectServices(files),
      ]),
      Effect.exit,
      Effect.map((exit) => ({ exit, output }))
    );
  };

  // A moment in check's reads of nb: its first read (the rules'), or its read for the Norwegian compile, after which
  // only the English pass reads it again.
  type Moment = { readonly when: string; readonly operation: "read" | "readExisting" };
  const MOMENTS: ReadonlyArray<Moment> = [
    { when: "its first read", operation: "read" },
    { when: "the Norwegian compile's read", operation: "readExisting" },
  ];

  // Node's catalog files, running `after` once, right after the first `operation` on nb.
  const afterFirst = (
    project: Project,
    operation: Moment["operation"],
    after: () => void
  ): Layer.Layer<CatalogFiles, never, FileSystem.FileSystem> => {
    const nb = project.path("messages/nb.po");
    let done = false;
    const hook = (path: string) =>
      Effect.sync(() => {
        if (!done && path === nb) {
          done = true;
          after();
        }
      });

    return Layer.effect(
      CatalogFiles,
      CatalogFiles.use((live) =>
        Effect.succeed(
          operation === "read"
            ? { ...live, read: (path: string) => live.read(path).pipe(Effect.tap(() => hook(path))) }
            : {
                ...live,
                readExisting: (path: string) => live.readExisting(path).pipe(Effect.tap(() => hook(path))),
              }
        )
      )
    ).pipe(Layer.provide(CatalogFiles.layer()));
  };

  it.effect.each(MOMENTS)("crashes on a PO removed after $when", ({ operation }, { project }) =>
    Effect.gen(function* () {
      yield* synced(project);
      const { exit } = yield* run(
        project,
        "check",
        afterFirst(project, operation, () => {
          rmSync(project.path("messages/nb.po"));
        })
      );

      expect(Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : exit).toMatch(/^Error: ENOENT/u);
    })
  );

  it.effect.each(MOMENTS)("reports a malformed PO swapped in after $when", ({ operation }, { project }) =>
    Effect.gen(function* () {
      yield* synced(project);
      const { exit, output } = yield* run(
        project,
        "check",
        afterFirst(project, operation, () => {
          project.write("messages/nb.po", `${project.read("messages/nb.po")}msgid "Broken\n`);
        })
      );

      expect(output).toContain("CatalogInvalid");
      expect(exit).toEqual(Exit.succeed("problems"));
    })
  );
});
