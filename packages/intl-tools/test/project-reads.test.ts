import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import { writeFileSync } from "node:fs";
import { expect, test } from "vitest";

import { nodeSyncError } from "../src/catalog-files";
import { scanProject, SourceCaches, SourceDiscovery } from "../src/project";
import { ProjectFormats } from "../src/project-formats-service";
import { NodePlatform } from "../src/project-services";
import { openProject } from "./project-fixture";

// Each test owns its project (see `Project`).
const it = test.extend("project", ({ task }, { onCleanup }) => {
  const { project, close } = openProject("elmera-intl-reads-", task.timeout);
  onCleanup(close);

  return project;
});

// Unit under test: the file-system boundary's mapping of a failed read to text. Oracle: Node's synchronous read, as
// the layer 5 CLI (963d3e4) printed it, as literals: `readFileSync` of a directory never names its path, and a NUL in
// a path is Node's own TypeError text. The inputs are the failures Node's asynchronous read reports: on Linux its
// EISDIR names the path, and effect's FileSystem prefixes an argument it rejects with `FileSystem.readFile: `.
test("words a failed read as Node's synchronous read does", () => {
  const eisdir = PlatformError.systemError({
    _tag: "BadResource",
    module: "FileSystem",
    method: "readFile",
    pathOrDescriptor: "/app/elmera-intl.json",
    syscall: "read",
    cause: Object.assign(
      new Error("EISDIR: illegal operation on a directory, read '/app/elmera-intl.json'"),
      {
        errno: -21,
        code: "EISDIR",
        syscall: "read",
        path: "/app/elmera-intl.json",
      }
    ),
  });
  const enoent = PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method: "readFile",
    pathOrDescriptor: "/app/f.ts",
    syscall: "open",
    cause: Object.assign(new Error("ENOENT: no such file or directory, open '/app/f.ts'"), {
      errno: -2,
      code: "ENOENT",
      syscall: "open",
      path: "/app/f.ts",
    }),
  });
  const nul = PlatformError.badArgument({
    module: "FileSystem",
    method: "readFile",
    description:
      "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received '/app/f\\x00.ts'",
  });

  expect([nodeSyncError(eisdir), nodeSyncError(enoent), nodeSyncError(nul)].map(String)).toEqual([
    "Error: EISDIR: illegal operation on a directory, read",
    "Error: ENOENT: no such file or directory, open '/app/f.ts'",
    "TypeError: The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received '/app/f\\x00.ts'",
  ]);
});

// Unit under test: `ProjectFormats`' memo, through Node's file system with a save landing right after the service
// reads the module (an editor's write between the read and the child's import). Oracle: the contract by hand: an
// evaluation is kept only for the text it evaluated, so once the module holds the valid text again, the next load
// evaluates it and returns its formats.
it("keeps no evaluation of a module saved between its read and its import", async ({ project }) => {
  const valid = `export const formats = { number: { money: { style: "currency", currency: "NOK" } } };\n`;
  project.write("intl-formats.ts", valid);
  const module = project.path("intl-formats.ts");
  let swapped = false;
  const saving = Layer.effect(
    FileSystem.FileSystem,
    FileSystem.FileSystem.useSync((live) => ({
      ...live,
      readFile: (path: string) =>
        live.readFile(path).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (path === module && !swapped) {
                swapped = true;
                writeFileSync(module, "export const formats = 5;\n");
              }
            })
          )
        ),
    }))
  ).pipe(Layer.provide(NodePlatform));
  const config = {
    root: project.root,
    include: ["src/**"],
    exclude: [],
    catalogs: "messages/{locale}.po",
    locales: ["nb"],
    formats: module,
  };

  const [first, second] = await Effect.runPromise(
    Effect.gen(function* () {
      const formats = yield* ProjectFormats;
      const during = yield* formats.load(config);
      project.write("intl-formats.ts", valid);

      return [during, yield* formats.load(config)] as const;
    }).pipe(Effect.provide(ProjectFormats.layer.pipe(Layer.provide(saving))))
  );

  expect([swapped, first._tag, second]).toEqual([
    true,
    "ConfigInvalid",
    { _tag: "Formats", formats: { number: { money: { style: "currency", currency: "NOK" } } } },
  ]);
});

// An in-memory file system holding one source, `/memory/src/example.ts`.
const SOURCE = `import { msg } from "@elmeragroup/intl/react";\nexport const M = msg("Hello");\n`;
const directoryInfo = (type: FileSystem.File.Type): FileSystem.File.Info => ({
  type,
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0n,
  ino: Option.none(),
  mode: 0o644,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: ByteSize.bytes(0),
  blksize: Option.none(),
  blocks: Option.none(),
});
const missing = (method: string, path: string) =>
  PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method, pathOrDescriptor: path });
const TREE = new Map<string, ReadonlyArray<FileSystem.DirectoryEntry>>([
  ["/memory", [{ name: "src", type: "Directory" }]],
  ["/memory/src", [{ name: "example.ts", type: "File" }]],
]);
const IN_MEMORY: Layer.Layer<FileSystem.FileSystem> = Layer.succeed(
  FileSystem.FileSystem,
  FileSystem.make({
    ...FileSystem.makeNoop({}),
    access: (path) =>
      TREE.has(path) || path === "/memory/src/example.ts"
        ? Effect.void
        : Effect.fail(missing("access", path)),
    stat: (path) =>
      TREE.has(path)
        ? Effect.succeed(directoryInfo("Directory"))
        : path === "/memory/src/example.ts"
          ? Effect.succeed(directoryInfo("File"))
          : Effect.fail(missing("stat", path)),
    readDirectoryEntries: (path) => {
      const entries = TREE.get(path);

      return entries === undefined
        ? Effect.fail(missing("readDirectoryEntries", path))
        : Effect.succeed(entries);
    },
    readFile: (path) =>
      path === "/memory/src/example.ts"
        ? Effect.succeed(new TextEncoder().encode(SOURCE))
        : Effect.fail(missing("readFile", path)),
  })
);

// Unit under test: `scanProject` on a file system that is not the host's disk. Oracle: the contract by hand: the scan
// finds its sources through the supplied file system, so the one source it holds is scanned and its include pattern
// matches; no `/memory` exists on the host's disk, so a walk of the disk would report `IncludeUnmatched`.
test("scans the sources of a file system that is not the host's disk", async () => {
  const scanned = await Effect.runPromise(
    scanProject({
      root: "/memory",
      include: ["src/**/*.ts"],
      exclude: [],
      catalogs: "messages/{locale}.po",
      locales: ["nb"],
      formats: undefined,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(SourceDiscovery.fileSystem, SourceCaches.layer).pipe(Layer.provideMerge(IN_MEMORY))
      )
    )
  );

  expect(scanned).toEqual({
    _tag: "Scanned",
    messages: [
      { key: "Hello", source: "Hello", context: undefined, references: ["src/example.ts"], comments: [] },
    ],
    unmatched: [],
  });
});
