import * as NodePath from "@effect/platform-node-shared/NodePath";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import { existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { expect, test, vi } from "vitest";

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

// The formats module's reads through Node's file system, counted, with a test's edits staged around the real read:
// `before(read)` runs before the read reaches the disk, `after(read)` once it has, each given the read's number.
type Staging = { readonly before?: (read: number) => void; readonly after?: (read: number) => void };
const stagedReads = (module: string, staging: Staging = {}) => {
  let reads = 0;
  const layer = Layer.effect(
    FileSystem.FileSystem,
    FileSystem.FileSystem.useSync((live) => ({
      ...live,
      readFile: (path: string) =>
        path === module
          ? Effect.sync(() => {
              reads += 1;
              staging.before?.(reads);

              return reads;
            }).pipe(
              Effect.flatMap((read) =>
                live.readFile(path).pipe(Effect.tap(() => Effect.sync(() => staging.after?.(read))))
              )
            )
          : live.readFile(path),
    }))
  ).pipe(Layer.provide(NodePlatform));

  return { layer, reads: () => reads };
};
const configFor = (root: string, formats: string) => ({
  root,
  include: ["src/**"],
  exclude: [],
  catalogs: "messages/{locale}.po",
  locales: ["nb"],
  formats,
});
// Two loads by one `ProjectFormats`, so the second can hit its memo.
const loadTwice = (layer: Layer.Layer<FileSystem.FileSystem>, config: ReturnType<typeof configFor>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const formats = yield* ProjectFormats;

      return [yield* formats.load(config), yield* formats.load(config)] as const;
    }).pipe(Effect.provide(ProjectFormats.layer.pipe(Layer.provide(layer))))
  );
const problemOf = (loaded: { readonly _tag: string; readonly problem?: { readonly message: string } }) =>
  loaded._tag === "ConfigInvalid" ? loaded.problem?.message : loaded._tag;
const moneyIn = (currency: string) =>
  `export const formats = { number: { money: { style: "currency", currency: "${currency}" } } };\n`;
const NOK = { _tag: "Formats", formats: { number: { money: { style: "currency", currency: "NOK" } } } };
const REFUSED = "cannot load: the formats module changed while Node loaded it, on all 3 attempts in total";

// Unit under test: `ProjectFormats.load` and its memo, through Node's file system, with an edit that the evaluation
// alone sees: the module changes right after the service reads it (before the child's import) and is restored before
// any later read, as an editor's save and undo would (#17). The edit changes the formats; the module's kind (an
// untyped `.js` whose format Node decides from its bytes, CommonJS turned ESM); leaves a partial save Node cannot
// strip (its load throws); or deletes the module (its resolution throws). Oracle: the contract by hand: no evaluation
// of bytes other than the text read is returned or memoized, so both loads return the formats of the text on disk at
// every read (NOK).
it.for([
  { kind: "formats", file: "intl-formats.ts", original: moneyIn("NOK"), edit: moneyIn("SEK") },
  {
    kind: "module kind",
    file: "untyped/intl-formats.js",
    original: `if (typeof exports === "object") exports.formats = { number: { money: { style: "currency", currency: "NOK" } } };\n`,
    edit: "export const formats = {};\n",
  },
  {
    kind: "partial save",
    file: "intl-formats.ts",
    original: moneyIn("NOK"),
    edit: "export const formats = {\n",
  },
  { kind: "deletion", file: "intl-formats.ts", original: moneyIn("NOK"), edit: undefined },
])(
  "never memoizes an evaluation of an edit only the import would see ($kind)",
  async (edited, { project }) => {
    project.write(edited.file, edited.original);
    const module = project.path(edited.file);
    let staged = false;
    const reads = stagedReads(module, {
      before: (read) => {
        if (read > 1) {
          writeFileSync(module, edited.original);
        }
      },
      after: (read) => {
        if (read === 1) {
          if (edited.edit === undefined) {
            rmSync(module);
          } else {
            writeFileSync(module, edited.edit);
          }
          staged =
            edited.edit === undefined ? !existsSync(module) : project.read(edited.file) === edited.edit;
        }
      },
    });
    const loads = await loadTwice(reads.layer, configFor(project.root, module));

    expect({ staged, loads, disk: project.read(edited.file) }).toEqual({
      staged: true,
      loads: [NOK, NOK],
      disk: edited.original,
    });
  }
);

// Unit under test: `ProjectFormats.load`, as above, while something else writes to the evaluating Node's stderr first
// (NODE_DEBUG=esm logs the loader's work there). The refusal is carried on the exit code and stdout, never stderr.
// Oracle: the contract by hand: the edit is refused and read again, so both loads return NOK.
it("refuses an edit while Node writes to stderr first", async ({ project }) => {
  vi.stubEnv("NODE_DEBUG", "esm");
  project.write("intl-formats.ts", moneyIn("NOK"));
  const module = project.path("intl-formats.ts");
  const reads = stagedReads(module, {
    before: (read) => {
      if (read > 1) {
        writeFileSync(module, moneyIn("NOK"));
      }
    },
    after: (read) => {
      if (read === 1) {
        writeFileSync(module, moneyIn("SEK"));
      }
    },
  });
  const loads = await loadTwice(reads.layer, configFor(project.root, module)).finally(() =>
    vi.unstubAllEnvs()
  );

  // The first load refused and read again; the second is a memo hit.
  expect({ reads: reads.reads(), loads }).toEqual({ reads: 3, loads: [NOK, NOK] });
});

// Unit under test: `loadFormats`, the loaders' load, on each module format the config admits (FORMATS_MODULE). The
// child evaluates the module only when Node's own load of it, which decides the format, read the text the parent read.
// Oracle: the export as each module writes it: type stripping for the TypeScript ones, ESM for an untyped `.js`,
// CommonJS for a `.js` under a `"type": "commonjs"` package (with a byte order mark too, which Node strips for
// CommonJS and the comparison keeps on both sides), and a module through a symlinked directory, which Node resolves to
// its real path.
it.for([
  [
    "intl-formats.ts",
    `type C = string;\nexport const formats = { number: { money: { style: "currency", currency: "NOK" as C } } };\n`,
  ],
  [
    "intl-formats.mts",
    `type C = string;\nexport const formats = { number: { money: { style: "currency", currency: "NOK" as C } } };\n`,
  ],
  [
    "intl-formats.mjs",
    `export const formats = { number: { money: { style: "currency", currency: "NOK" } } };\n`,
  ],
  [
    "intl-formats.js",
    `export const formats = { number: { money: { style: "currency", currency: "NOK" } } };\n`,
  ],
  [
    "linked/intl-formats.ts",
    `export const formats = { number: { money: { style: "currency", currency: "NOK" } } };\n`,
  ],
  [
    "cjs/intl-formats.js",
    `exports.formats = { number: { money: { style: "currency", currency: "NOK" } } };\n`,
  ],
  ["cjs/bom.js", `\uFEFFexports.formats = { number: { money: { style: "currency", currency: "NOK" } } };\n`],
] as const)("loads the formats module %s", ([file, module], { project }) => {
  if (file.startsWith("cjs/")) {
    project.write("cjs/package.json", `{ "type": "commonjs" }\n`);
  }
  if (file.startsWith("linked/")) {
    project.write(file.replace("linked/", "real/"), module);
    symlinkSync("real", project.path("linked"));
  } else {
    project.write(file, module);
  }

  expect(
    loadFormats({
      root: project.root,
      include: ["src/**"],
      exclude: [],
      catalogs: "messages/{locale}.po",
      locales: ["nb"],
      formats: project.path(file),
    })
  ).toEqual({ _tag: "Formats", formats: { number: { money: { style: "currency", currency: "NOK" } } } });
});

// Unit under test: `ProjectFormats.load`, on a module that changes after every read (an editor saving it over and over).
// Oracle: the contract by hand: each evaluation is refused, the load reads and evaluates the module 3 times in all and
// then reports it, and keeps nothing, so a load once it holds still returns its formats.
it("reports a module that changes while Node loads it on every attempt, and keeps nothing", async ({
  project,
}) => {
  project.write("intl-formats.ts", moneyIn("NOK"));
  const module = project.path("intl-formats.ts");
  let editing = true;
  let firstReads = 0;
  const reads = stagedReads(module, {
    after: (read) => {
      if (editing) {
        writeFileSync(module, moneyIn(read % 2 === 0 ? "NOK" : "SEK"));
      }
    },
  });
  const [changing, held] = await Effect.runPromise(
    Effect.gen(function* () {
      const formats = yield* ProjectFormats;
      const first = yield* formats.load(configFor(project.root, module));
      firstReads = reads.reads();
      editing = false;
      writeFileSync(module, moneyIn("NOK"));

      return [first, yield* formats.load(configFor(project.root, module))] as const;
    }).pipe(Effect.provide(ProjectFormats.layer.pipe(Layer.provide(reads.layer))))
  );

  expect({ reads: firstReads, changing: problemOf(changing), held }).toEqual({
    reads: 3,
    changing: REFUSED,
    held: NOK,
  });
});

// Unit under test: `ProjectFormats.load`, on a stable module that throws the refusal's own sentence. A refusal is the
// evaluating Node's own signal (exit 75 with its payload on stdout), never a module's error text, so this is the
// module's own failure. Oracle: the contract by hand: one read per load, its error reported as it is.
it("reports a module that throws the refusal's sentence as its own error, without retrying", async ({
  project,
}) => {
  project.write(
    "intl-formats.ts",
    `throw new Error("the formats module changed while Node loaded it");\nexport const formats = {};\n`
  );
  const reads = stagedReads(project.path("intl-formats.ts"));
  const [first] = await loadTwice(reads.layer, configFor(project.root, project.path("intl-formats.ts")));

  expect({ reads: reads.reads(), first: problemOf(first) }).toEqual({
    reads: 2,
    first: "cannot load: Error: the formats module changed while Node loaded it",
  });
});

// Unit under test: `ProjectFormats.load`, on a module that fakes the refusal signal (its payload on stdout, then exit
// 75). Oracle: the contract by hand: a fake can only cost retries and a report, never a kept result: 3 reads per load,
// each load reported, so the second load reads 3 times again.
it("lets a module faking the refusal cause only retries and a report", async ({ project }) => {
  project.write(
    "intl-formats.ts",
    `import { writeSync } from "node:fs";\nwriteSync(1, JSON.stringify({ elmeraIntlRefused: "the formats module changed while Node loaded it" }));\nprocess.exit(75);\nexport const formats = {};\n`
  );
  const reads = stagedReads(project.path("intl-formats.ts"));
  const loads = await loadTwice(reads.layer, configFor(project.root, project.path("intl-formats.ts")));

  expect({ reads: reads.reads(), loads: loads.map((loaded) => problemOf(loaded)) }).toEqual({
    reads: 6,
    loads: [REFUSED, REFUSED],
  });
});

// Unit under test: both formats memos, `ProjectFormats.load` and the loaders' `loadFormats`, on a module that loads but
// is invalid for a cause outside its own text: it re-exports formats from a module that holds none yet. Oracle: the
// contract by hand: only valid formats are kept, so once the other module holds them the same, unedited module loads.
it("keeps no invalid formats, so a module whose import is fixed loads unedited", async ({ project }) => {
  const formats = { number: { money: { style: "currency", currency: "NOK" } } };
  const setUp = (name: string) => {
    project.write(`${name}/intl-formats.ts`, `export { formats } from "./dep.ts";\n`);
    project.write(`${name}/dep.ts`, "export const formats = 5;\n");

    return configFor(project.root, project.path(`${name}/intl-formats.ts`));
  };
  const fix = (name: string) => {
    project.write(`${name}/dep.ts`, `export const formats = ${JSON.stringify(formats)};\n`);
  };
  const service = setUp("service");
  const loader = setUp("loader");

  const viaService = await Effect.runPromise(
    Effect.gen(function* () {
      const loaded = yield* ProjectFormats;
      const before = yield* loaded.load(service);
      fix("service");

      return [before, yield* loaded.load(service)] as const;
    }).pipe(Effect.provide(ProjectFormats.layer.pipe(Layer.provide(NodePlatform))))
  );
  const before = loadFormats(loader);
  fix("loader");
  const viaLoader = [before, loadFormats(loader)] as const;

  expect([viaService, viaLoader].map(([first, second]) => [first._tag, second])).toEqual([
    ["ConfigInvalid", { _tag: "Formats", formats }],
    ["ConfigInvalid", { _tag: "Formats", formats }],
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
    sources: ["/memory/src/example.ts"],
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
    sources: [WIN32_SOURCE],
  });
});
