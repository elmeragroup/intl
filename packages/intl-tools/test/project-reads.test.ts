import * as NodePath from "@effect/platform-node-shared/NodePath";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import { writeFileSync } from "node:fs";
import { expect, test } from "vitest";

import { nodeSyncError, platformFailed } from "../src/catalog-files";
import { scanProject, SourceCaches, SourceDiscovery } from "../src/project";
import { loadFormats } from "../src/project-formats";
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

// Unit under test: both formats memos, `ProjectFormats.load` (through Node's file system) and the loaders' `loadFormats`,
// on a module whose evaluation fails for a cause outside its own text: it imports a module not there yet. Oracle: the
// settled contract by hand: a failed evaluation is re-run on every load, but only while the module is broken, so once
// the import exists the next load of the same, unedited module returns its formats.
it("keeps no failed evaluation, so a module whose import appears loads unedited", async ({ project }) => {
  const formats = { number: { money: { style: "currency", currency: "NOK" } } };
  const config = (name: string) => {
    project.write(
      `${name}/intl-formats.ts`,
      `import { currency } from "./dep.ts";\nexport const formats = { number: { money: { style: "currency", currency } } };\n`
    );

    return {
      root: project.root,
      include: ["src/**"],
      exclude: [],
      catalogs: "messages/{locale}.po",
      locales: ["nb"],
      formats: project.path(`${name}/intl-formats.ts`),
    };
  };
  const dep = (name: string) => {
    project.write(`${name}/dep.ts`, `export const currency = "NOK";\n`);
  };
  const service = config("service");
  const loader = config("loader");

  const viaService = await Effect.runPromise(
    Effect.gen(function* () {
      const loaded = yield* ProjectFormats;
      const before = yield* loaded.load(service);
      dep("service");

      return [before, yield* loaded.load(service)] as const;
    }).pipe(Effect.provide(ProjectFormats.layer.pipe(Layer.provide(NodePlatform))))
  );
  const before = loadFormats(loader);
  dep("loader");
  const viaLoader = [before, loadFormats(loader)] as const;

  expect([viaService, viaLoader].map(([first, second]) => [first._tag, second])).toEqual([
    ["ConfigInvalid", { _tag: "Formats", formats }],
    ["ConfigInvalid", { _tag: "Formats", formats }],
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

// Discovery by the supplied file system's own `glob`, for a file system that is not the host's disk.
const GLOB_DISCOVERY: Layer.Layer<SourceDiscovery, never, FileSystem.FileSystem> = Layer.effect(
  SourceDiscovery,
  FileSystem.FileSystem.useSync((files) => ({
    find: (root: string, pattern: string, exclude: ReadonlyArray<string>) =>
      files.glob(pattern, { root, exclude }).pipe(Effect.mapError(platformFailed("scan"))),
  }))
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
        Layer.mergeAll(GLOB_DISCOVERY, SourceCaches.layer).pipe(
          Layer.provideMerge(Layer.merge(IN_MEMORY, NodePath.layerPosix))
        )
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

// A Win32 file system holding one source, `C:\memory\src\example.ts`, as Windows paths alone: its walk answers in
// `FileSystem.glob`'s terms (root-relative, `/`-separated), and every other operation knows only the backslashed path.
const WIN32_SOURCE = "C:\\memory\\src\\example.ts";
const win32Stat = Effect.fn("Win32.stat")(function* (path: string) {
  return path === WIN32_SOURCE ? directoryInfo("File") : yield* missing("stat", path);
});
const WIN32: Layer.Layer<FileSystem.FileSystem> = Layer.succeed(FileSystem.FileSystem, {
  ...FileSystem.makeNoop({}),
  // Its walk of `C:\memory` for `src/**/*.ts`: the source, which it finds by its own path.
  glob: Effect.fn("Win32.glob")(function* (
    pattern: string,
    options?: { readonly root?: string | undefined }
  ) {
    const walked = options?.root === "C:\\memory" && pattern === "src/**/*.ts";
    const found = walked && (yield* win32Stat(WIN32_SOURCE)).type === "File";

    return found ? ["src/example.ts"] : [];
  }),
  stat: win32Stat,
  readFile: Effect.fn("Win32.readFile")(function* (path: string) {
    return path === WIN32_SOURCE ? new TextEncoder().encode(SOURCE) : yield* missing("readFile", path);
  }),
});

// Unit under test: `scanProject` on a Win32 file system, with Win32 paths, whatever the host. Oracle: the contract by
// hand: the scan builds each source's path with the supplied `Path`, so the one source the file system holds is found
// and scanned, and its include pattern matches.
test("scans a Win32 file system with Win32 paths on any host", async () => {
  const scanned = await Effect.runPromise(
    scanProject({
      root: "C:\\memory",
      include: ["src/**/*.ts"],
      exclude: [],
      catalogs: "messages/{locale}.po",
      locales: ["nb"],
      formats: undefined,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(GLOB_DISCOVERY, SourceCaches.layer).pipe(
          Layer.provideMerge(Layer.merge(WIN32, NodePath.layerWin32))
        )
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
