// The workspace as the rules see it: which package a linted file belongs to, read from the nearest package.json, and
// the surface a published package commits. The plugin's one JSON boundary: manifests and surfaces are parsed here,
// once each, into the fields the rules use.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

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
