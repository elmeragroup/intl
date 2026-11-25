// Where Turbopack, as Next 16.4.6 sets it up, loads what the PO loader reads: its root, its additional roots, and the
// catalogs' path below the root that the PO rule matches. Where Turbopack compiles, a file it would refuse at the first
// catalog import fails here instead, at config time. Every rule here can only turn a refusal into an accept, never the
// reverse: a missed refusal leaves Turbopack's own `outside configured roots` error, as with no check, while a false
// one breaks a build that works. So the model is deliberately coarser than Turbopack's, and errs towards accepting.
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Problem } from "./problem";
import type { ProjectConfig } from "./project-config";

/** The Next settings Turbopack's roots, and whether an adapter rewrites them, come from. */
export type TurbopackRootsConfig = {
  readonly outputFileTracingRoot?: string;
  readonly turbopack?: { readonly root?: string };
  readonly experimental?: object;
  readonly adapterPath?: string;
};

/** The catalogs' path below Turbopack's root, or why Turbopack would load no catalog. */
export type CatalogPathBelowRoot =
  | {
      readonly _tag: "CatalogPath";
      /** The catalogs pattern relative to Turbopack's root, `/`-separated, `{locale}` kept: what the PO rule matches. */
      readonly path: string;
    }
  | { readonly _tag: "OutsideTurbopackRoots"; readonly problem: Problem };

/**
 * The configured catalogs' path relative to Turbopack's root, after the placement checks where they run.
 *
 * The checks run only where this process compiles with Turbopack: Next's CLI running `next build` in a mode that
 * compiles, without `--webpack`, or a process with Next's dev-server marker (the `next dev` child, a dev custom server),
 * in each case with `TURBOPACK` set, Rspack not selected and no adapter selected (`adapterPath`,
 * `experimental.adapterPath` or `NEXT_ADAPTER_PATH`: an adapter's `modifyConfig` may add roots after this config is
 * evaluated). There, the intl config and its formats module must lie in Turbopack's root or an additional root (the PO
 * loader registers both as dependencies of a catalog import), and the catalogs in the root (the rule's path is relative
 * to it).
 *
 * @param next - The Next config withIntl wraps.
 * @param project - The parsed intl config.
 * @param configPath - The intl config's absolute path, as the PO loader receives it.
 * @param app - The Next project directory.
 * @returns The catalogs' root-relative path, or the problem naming the file and the setting to widen.
 */
export function catalogPathBelowRoot(
  next: TurbopackRootsConfig,
  project: ProjectConfig,
  configPath: string,
  app: string
): CatalogPathBelowRoot {
  const root = turbopackRoot(next, app);
  const catalogs = resolve(project.root, project.catalogs);
  const path = relative(root.directory, catalogs).split(sep).join("/");

  if (!compilesWithTurbopack(next)) {
    return { _tag: "CatalogPath", path };
  }

  const additional = additionalRoots(next);
  const roots = [root.directory, ...additional];
  const real = roots.map((directory) => canonical(directory) ?? directory);
  const fix = `set ${root.setting} to a directory that holds the app, the intl config, its formats module and its catalogs`;
  const named = `the Turbopack root ${root.directory}${additional.length === 0 ? "" : ` and its additional roots ${additional.join(", ")}`}`;
  const files = [
    { what: "the intl config", file: configPath },
    ...(project.formats === undefined ? [] : [{ what: "the formats module", file: project.formats }]),
  ];
  const outside = files.find(({ file }) => !isInRoots(roots, real, file));

  if (outside !== undefined) {
    return {
      _tag: "OutsideTurbopackRoots",
      problem: {
        code: "OutsideTurbopackRoots",
        message: `${outside.what} ${outside.file} is outside ${named}, so Turbopack loads no catalog that depends on it`,
        fix: `${fix}${isListable(real, outside.file) ? ", or list its directory in experimental.turbopackAdditionalRoots" : ""}`,
        file: outside.file,
      },
    };
  }

  if (!isBelow(root.directory, catalogs)) {
    return {
      _tag: "OutsideTurbopackRoots",
      problem: {
        code: "OutsideTurbopackRoots",
        message: `the catalogs ${project.catalogs} are outside the Turbopack root ${root.directory}, and the PO rule matches catalog paths relative to it`,
        fix,
        file: catalogs,
      },
    };
  }

  return { _tag: "CatalogPath", path };
}

// Turbopack's root, and the setting that decides it: `outputFileTracingRoot` when set (Next uses it over
// `turbopack.root`, warning when they differ), else `turbopack.root`, which also overrides Next's own detection.
type TurbopackRoot = {
  readonly directory: string;
  readonly setting: "outputFileTracingRoot" | "turbopack.root";
};

// Turbopack's root as Next 16.4 sets it (server/config.js): `outputFileTracingRoot`, else `turbopack.root`, else Next's
// own detection from the project directory (lib/find-root.js: the topmost workspace marker or lockfile, bounded by
// the git repository and the home directory), called rather than ported so the root always matches the installed Next.
// Relative settings resolve against the working directory, as Next's do (a bare `resolve()`). Next's private
// NEXT_PRIVATE_OUTPUT_TRACE_ROOT override, which replaces the detection, is left out: no build here sets it.
function turbopackRoot(config: TurbopackRootsConfig, app: string): TurbopackRoot {
  if (config.outputFileTracingRoot !== undefined && config.outputFileTracingRoot !== "") {
    return { directory: resolve(config.outputFileTracingRoot), setting: "outputFileTracingRoot" };
  }

  if (config.turbopack?.root !== undefined && config.turbopack.root !== "") {
    return { directory: resolve(config.turbopack.root), setting: "turbopack.root" };
  }

  // SAFETY: Next's own module (unexported, so untyped), present in every Next >= 16.4 that runs this config; the
  // next.test.ts root cases go red if its shape changes.
  const { findRootDirAndLockFiles } = createRequire(join(app, "package.json"))(
    "next/dist/lib/find-root.js"
  ) as {
    readonly findRootDirAndLockFiles: (dir: string) => { readonly rootDir: string };
  };

  return { directory: findRootDirAndLockFiles(app).rootDir, setting: "turbopack.root" };
}

// Whether this process compiles with Turbopack, on positive evidence only, as Next 16.4.6 sets it up before it loads
// next.config (logged from a next.config for #53). Every clause can only skip the checks:
// - TURBOPACK set: Next sets it wherever it selects Turbopack (lib/bundler.js, parseBundlerArgs; server/next.js,
//   createServer, for any custom server), but also where nothing compiles (`next start`, a production custom server,
//   `next typegen`, a shell or `.env.production` that sets it), hence the evidence below.
// - NEXT_RSPACK unset: Next selects Rspack over TURBOPACK (getBundlerFromEnv; finalizeBundlerFromConfig after the config
//   loads).
// - No adapter: Next runs an adapter's modifyConfig after evaluating next.config (server/config.js, applyModifyConfig),
//   where it may add additional roots or change the root. Next selects one by `adapterPath`, by
//   `experimental.adapterPath` (moved to `adapterPath`) or by NEXT_ADAPTER_PATH (config-shared.js, the default).
// - Argv first: Next's own CLI decides by its arguments (nextCli). Elsewhere only __NEXT_DEV_SERVER counts: the
//   `next dev` child's env (cli/next-dev.js) and a dev custom server's prepare(); a marker inherited into Next's CLI
//   (`next build --experimental-build-mode generate` or `next start` run from a dev process) counts for nothing.
function compilesWithTurbopack(next: TurbopackRootsConfig): boolean {
  const { TURBOPACK, NEXT_RSPACK, NEXT_ADAPTER_PATH, __NEXT_DEV_SERVER } = process.env;

  if (!isSet(TURBOPACK) || isSet(NEXT_RSPACK) || isSet(NEXT_ADAPTER_PATH) || selectsAdapter(next)) {
    return false;
  }

  const cli = nextCli(process.argv);

  return cli === "CompilingBuild" || (cli === "NotNextCli" && isSet(__NEXT_DEV_SERVER));
}

// Whether an environment variable is set as Next reads it: by truthiness, so an empty one is unset.
function isSet(variable: string | undefined): boolean {
  return variable !== undefined && variable !== "";
}

// Whether the config selects an adapter, as Next reads it: truthy `adapterPath`, or `experimental.adapterPath`.
function selectsAdapter(next: TurbopackRootsConfig): boolean {
  const experimental = new Map<string, ConfigValue>(Object.entries(next.experimental ?? {}));

  return Boolean(next.adapterPath) || Boolean(experimental.get("adapterPath"));
}

// What argv says when it runs Next's own CLI (bin/next, through a `.bin/next` link or a shim), by its arguments alone.
type NextCli = "CompilingBuild" | "OtherCommand" | "NotNextCli";

const BUILD_MODE = "--experimental-build-mode";
const NON_COMPILING_MODES: ReadonlySet<string> = new Set(["generate", "generate-env"]);

// bin/next takes the command as its first argument (no global option but -v and -h). `build` compiles unless a token
// anywhere selects webpack (`--webpack`, which `.env.production`'s TURBOPACK cannot undo: Next chose the bundler before
// loading it) or names a mode that compiles nothing (`generate`, Turbopack's `generate-env`), as `=mode` or anywhere
// after a bare `--experimental-build-mode`. No option parsing: an option that takes a value
// (`--experimental-upload-trace <url>`) can swallow a later mode, so any such token, wherever it sits, skips.
function nextCli(argv: ReadonlyArray<string>): NextCli {
  const [, script, command, ...args] = argv;

  if (
    script === undefined ||
    canonical(script)?.endsWith(`${sep}${join("next", "dist", "bin", "next")}`) !== true
  ) {
    return "NotNextCli";
  }

  if (command !== "build") {
    return "OtherCommand";
  }

  const skips = args.some(
    (arg, index) =>
      arg === "--webpack" ||
      (arg.startsWith(`${BUILD_MODE}=`) && NON_COMPILING_MODES.has(arg.slice(BUILD_MODE.length + 1))) ||
      (NON_COMPILING_MODES.has(arg) && args.slice(0, index).includes(BUILD_MODE))
  );

  return skips ? "OtherCommand" : "CompilingBuild";
}

// Whether Turbopack can load a file the loader registers, coarser than turbo-tasks-fs at v16.4.6 (disk.rs,
// canonicalized_path_cache.rs) and never refusing what it loads: the file lies in a root, as written or resolved, or
// any directory above it resolves, through its links, to a resolved root or into one. The file itself is not resolved:
// Turbopack refuses a file linked into a root from outside it (replayed for #53). Turbopack also refuses some paths
// accepted here (a directory linked from outside strictly into a root); those get its own error.
function isInRoots(roots: ReadonlyArray<string>, real: ReadonlyArray<string>, file: string): boolean {
  if ([...roots, ...real].some((root) => isBelow(root, file))) {
    return true;
  }

  return ancestors(file).some((directory) => {
    const resolved = canonical(directory);

    return resolved !== undefined && real.some((root) => isBelow(root, resolved));
  });
}

// The directories above an absolute path, nearest first, the filesystem root last.
function ancestors(path: string): ReadonlyArray<string> {
  const parent = dirname(path);

  return parent === path ? [] : [parent, ...ancestors(parent)];
}

// Whether listing a file's directory as an additional root would make Turbopack load it, where Next keeps the root:
// an existing directory (Next drops a missing one) that overlaps no resolved root (Next drops one that holds or lies in
// a root).
function isListable(real: ReadonlyArray<string>, file: string): boolean {
  const directory = canonical(dirname(file));

  return (
    directory !== undefined && !real.some((root) => isBelow(root, directory) || isBelow(directory, root))
  );
}

// The real path of an existing file or directory, or none when it does not resolve (missing, or unreadable).
function canonical(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

// The directories `experimental.turbopackAdditionalRoots` names, each resolved from the working directory through its
// links (as Next does, crates/next-api/src/additional_roots.rs), an entry that does not resolve left out (Next drops
// it). Every other entry counts, though Next drops some (an invalid or duplicate name, one that overlaps the root or an
// earlier one): where an entry Next drops holds a file, the check misses a refusal, never makes one up.
function additionalRoots(config: TurbopackRootsConfig): ReadonlyArray<string> {
  const entries = new Map<string, ConfigValue>(Object.entries(config.experimental ?? {})).get(
    "turbopackAdditionalRoots"
  );

  return (isConfigObject(entries) ? Object.values(entries) : []).flatMap((entry) => {
    const path = isConfigObject(entry) ? entry.path : undefined;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- additionalRoots parses untyped next.config values, and typeof reads a string without coercing an object (String() of a null-prototype object throws)
    const directory = typeof path === "string" ? canonical(path) : undefined;

    return directory === undefined ? [] : [directory];
  });
}

// What an untyped next.config.mjs may hold where Next's types promise an object: anything, its fields by name.
type ConfigValue = ConfigObject | string | number | bigint | boolean | symbol | null | undefined;
type ConfigObject = { readonly [field: string]: ConfigValue };

// Whether an untyped next.config value is an object or a function, whose fields can be read.
function isConfigObject(value: ConfigValue): value is ConfigObject {
  return Object(value) === value;
}

/**
 * Whether a path lies in a directory, or is it.
 *
 * @param directory - The directory.
 * @param path - The path.
 * @returns Whether the path is the directory or below it, lexically.
 */
export function isBelow(directory: string, path: string): boolean {
  const below = relative(directory, path);

  return below !== ".." && !below.startsWith(`..${sep}`) && !isAbsolute(below);
}
