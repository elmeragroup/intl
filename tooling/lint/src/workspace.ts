// The workspace as the rules see it: which package a linted file belongs to, read from the nearest package.json, the
// surface a published package commits, the workspace root, and file-copies' option. The plugin's one JSON boundary:
// manifests, surfaces and rule options are parsed here, manifests and surfaces once each, into the fields the rules use.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep, win32 } from "node:path";

/** The export condition that maps every workspace subpath to its source file. */
export const SOURCE_CONDITION = "elmera-source";

/** One `exports` subpath of a package, as the rules need it. */
export type ExportEntry = {
  /** The subpath, such as `./core`. */
  readonly subpath: string;
  /** Absolute paths of the source files its `elmera-source` conditions name, the react-server one included. */
  readonly sources: ReadonlyArray<string>;
};

/** A workspace package: its directory and the manifest fields the rules read. */
export type WorkspacePackage = {
  /** Absolute directory holding the package.json. */
  readonly root: string;
  /** The `name` field, or `undefined` for a manifest without one (the fixture apps' own). */
  readonly name: string | undefined;
  /** Published: the manifest is not `private`. */
  readonly published: boolean;
  /** Names in `dependencies` and `peerDependencies`: what a consumer's install brings. */
  readonly installed: ReadonlySet<string>;
  /** Names in `devDependencies`. */
  readonly development: ReadonlySet<string>;
  /** The `exports` map's subpaths. */
  readonly exports: ReadonlyArray<ExportEntry>;
};

/** The runtime package. */
export const RUNTIME = "@elmeragroup/intl";
/** The build-time tools package. */
export const TOOLS = "@elmeragroup/intl-tools";
/** The private e2e harness package. */
export const E2E = "@elmeragroup/intl-e2e";
/** The workspace directory that holds the example apps (`apps/<name>`), as pnpm-workspace.yaml globs it. */
export const APPS_DIRECTORY = "apps";

const byDirectory = new Map<string, WorkspacePackage | undefined>();

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keysOf(value: unknown): ReadonlyArray<string> {
  return isRecord(value) ? Object.keys(value) : [];
}

// Every `elmera-source` target in one subpath's condition tree, nested conditions (react-server) included.
function sourceTargets(root: string, target: unknown): ReadonlyArray<string> {
  if (!isRecord(target)) {
    return [];
  }

  return Object.entries(target).flatMap(([condition, value]) => {
    if (condition === SOURCE_CONDITION) {
      return typeof value === "string" ? [resolve(root, value)] : sourceTargets(root, value);
    }

    return sourceTargets(root, value);
  });
}

function parseManifest(root: string, text: string): WorkspacePackage {
  const manifest: unknown = JSON.parse(text);
  const fields = isRecord(manifest) ? manifest : {};
  const exportsField = isRecord(fields.exports) ? fields.exports : {};

  return {
    root,
    name: typeof fields.name === "string" ? fields.name : undefined,
    published: fields.private !== true,
    installed: new Set([...keysOf(fields.dependencies), ...keysOf(fields.peerDependencies)]),
    development: new Set(keysOf(fields.devDependencies)),
    exports: Object.entries(exportsField).map(([subpath, target]) => ({
      subpath,
      sources: sourceTargets(root, target),
    })),
  };
}

/**
 * The package a file belongs to: the nearest package.json above it.
 *
 * @param filename - Absolute path of the linted file.
 * @returns The package, or `undefined` when no package.json is above the file.
 */
export function packageOf(filename: string): WorkspacePackage | undefined {
  const directory = dirname(filename);

  if (byDirectory.has(directory)) {
    return byDirectory.get(directory);
  }

  const manifestPath = join(directory, "package.json");
  const parent = dirname(directory);
  const found = existsSync(manifestPath)
    ? parseManifest(directory, readFileSync(manifestPath, "utf8"))
    : parent === directory
      ? undefined
      : packageOf(join(parent, "package.json"));

  byDirectory.set(directory, found);

  return found;
}

/**
 * Whether the package is an example app: a private package directly under the workspace's `apps/`. Nothing depends on
 * an app, and none publishes.
 *
 * @param pkg - A workspace package.
 * @returns `true` for `apps/<name>`.
 */
export function isApp(pkg: WorkspacePackage): boolean {
  return !pkg.published && basename(dirname(pkg.root)) === APPS_DIRECTORY;
}

/**
 * The file's path inside its package, with `/` separators.
 *
 * @param pkg - The file's package.
 * @param filename - Absolute path of the file.
 * @returns The relative path, such as `src/core.ts`.
 */
export function pathInPackage(pkg: WorkspacePackage, filename: string): string {
  return relative(pkg.root, filename).split(sep).join("/");
}

/**
 * Whether the file is part of a published package's shipped source (`src/`).
 *
 * @param pkg - The file's package.
 * @param filename - Absolute path of the file.
 * @returns `true` for a file under a published package's `src/`.
 */
export function isPublishedSource(pkg: WorkspacePackage, filename: string): boolean {
  return pkg.published && pathInPackage(pkg, filename).startsWith("src/");
}

/** Where a published package commits its public surface, relative to its root. */
export const SURFACE_FILE = "test/public-surface.json";

/** A committed public surface: each public subpath and the runtime names it exports. */
export type Surface = ReadonlyMap<string, ReadonlySet<string>>;

const surfaces = new Map<string, Surface | undefined>();

/**
 * The public surface a package commits in `test/public-surface.json`.
 *
 * @param pkg - A published package.
 * @returns Its surface, or `undefined` when the file is missing or not an object of name arrays.
 */
export function readSurface(pkg: WorkspacePackage): Surface | undefined {
  if (surfaces.has(pkg.root)) {
    return surfaces.get(pkg.root);
  }

  const path = join(pkg.root, SURFACE_FILE);
  const parsed: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  const surface = isRecord(parsed)
    ? new Map(
        Object.entries(parsed).flatMap(([subpath, names]) =>
          Array.isArray(names)
            ? [[subpath, new Set(names.filter((name): name is string => typeof name === "string"))] as const]
            : []
        )
      )
    : undefined;

  surfaces.set(pkg.root, surface);

  return surface;
}

// The file that marks the workspace root.
const WORKSPACE_MARKER = "pnpm-workspace.yaml";

const rootByDirectory = new Map<string, string | undefined>();

/**
 * The workspace root above a file: the nearest directory holding `pnpm-workspace.yaml`. Found from the file, not from
 * where lint started, so an editor or a run from a subdirectory sees the same root.
 *
 * @param filename - Absolute path of the linted file.
 * @returns The root's absolute path, or `undefined` when no `pnpm-workspace.yaml` is above the file.
 */
export function workspaceRootOf(filename: string): string | undefined {
  const directory = dirname(filename);

  if (rootByDirectory.has(directory)) {
    return rootByDirectory.get(directory);
  }

  const parent = dirname(directory);
  const found = existsSync(join(directory, WORKSPACE_MARKER))
    ? directory
    : parent === directory
      ? undefined
      : workspaceRootOf(directory);

  rootByDirectory.set(directory, found);

  return found;
}

/** The `elmera-workspace/file-copies` option, canonical: one original and the distinct files that must equal it. */
export type FileCopies = {
  /** The original's path from the workspace root: `/` separators, normalized, inside the root. */
  readonly original: string;
  /** Each copy's path from the workspace root, in the same form; none is the original, and none is listed twice. */
  readonly copies: ReadonlyArray<string>;
};

/** The rule's option, parsed: its canonical paths, or why it checks nothing. */
export type FileCopiesOption =
  | { readonly _tag: "Parsed"; readonly files: FileCopies }
  | { readonly _tag: "Invalid"; readonly reason: string };

type CanonicalPath =
  | { readonly _tag: "Path"; readonly path: string }
  | { readonly _tag: "Invalid"; readonly reason: string };

// A configured path as the workspace-relative form files are matched in: `/` separators, a leading `./` and redundant
// segments gone. A path that is absolute, or does not name a file inside the root, matches nothing.
function canonicalPath(path: string): CanonicalPath {
  if (posix.isAbsolute(path) || win32.isAbsolute(path)) {
    return { _tag: "Invalid", reason: `"${path}" is absolute` };
  }

  const normal = posix.normalize(path);

  if (normal === "." || normal === ".." || normal.startsWith("../") || normal.endsWith("/")) {
    return { _tag: "Invalid", reason: `"${path}" does not name a file inside the workspace root` };
  }

  return { _tag: "Path", path: normal };
}

/**
 * The rule's option, parsed from its configured options array (`[{ original, copies }]`). Complete on its own, so the
 * config test can parse the committed setting as the rule does: exactly one option object with at least one copy, each
 * path workspace-relative and inside the root, no copy the original, and no copy listed twice, once canonical. oxlint's
 * schema check states the same structure to a user's config at load.
 *
 * @param options - The rule's options, as oxlint passes them.
 * @returns The canonical paths, or the reason the option checks nothing.
 */
export function parseFileCopies(options: ReadonlyArray<unknown>): FileCopiesOption {
  const [option] = options;
  const notAnOption = { _tag: "Invalid", reason: "it is not one { original, copies } object" } as const;

  if (options.length !== 1 || !isRecord(option)) {
    return notAnOption;
  }

  const { original, copies } = option;

  if (
    typeof original !== "string" ||
    !Array.isArray(copies) ||
    !copies.every((copy) => typeof copy === "string")
  ) {
    return notAnOption;
  }

  if (copies.length === 0) {
    return { _tag: "Invalid", reason: "it lists no copy" };
  }

  const canonicalOriginal = canonicalPath(original);

  if (canonicalOriginal._tag === "Invalid") {
    return canonicalOriginal;
  }

  const seen = new Set<string>();

  for (const copy of copies) {
    const canonical = canonicalPath(copy);

    if (canonical._tag === "Invalid") {
      return canonical;
    }

    if (canonical.path === canonicalOriginal.path) {
      return { _tag: "Invalid", reason: `the copy "${copy}" is the original` };
    }

    if (seen.has(canonical.path)) {
      return { _tag: "Invalid", reason: `the copy "${copy}" is listed twice` };
    }

    seen.add(canonical.path);
  }

  return { _tag: "Parsed", files: { original: canonicalOriginal.path, copies: [...seen] } };
}
