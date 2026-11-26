/**
 * Installs the workspace on the lowest version of each peer the published packages declare, for merge.yml's floors
 * job, which then runs the packages' and the effect example's unit tests and the fixture e2e on that install:
 *
 *   node scripts/peer-floors.ts [pnpm install flags]   # e.g. --no-runtime, as CI's installs pass it
 *
 * `pnpm-workspace.yaml`'s `floors` catalog names each version (the peers' floors and the companions that move with
 * them). The script, in order:
 *
 * 1. refuses a checkout with uncommitted changes, since it rewrites `pnpm-workspace.yaml` and `pnpm-lock.yaml` in
 *    place (locally, run it in a scratch worktree; `git checkout -- pnpm-workspace.yaml pnpm-lock.yaml` then
 *    `pnpm install --frozen-lockfile` undoes it, putting `node_modules` back on the catalog);
 * 2. reads the catalogs as pnpm parses them, puts each floors version in place of the same entry in the one other
 *    catalog that has it (so every package that takes that entry takes the floor), writes them back with
 *    `pnpm config set --location=project --json`, so pnpm alone reads and writes the YAML, then parses the file again
 *    and refuses to install unless exactly those entries changed (pnpm keeps the file's comments today; one it drops in
 *    CI's throwaway checkout would not matter);
 * 3. runs `pnpm install --no-frozen-lockfile` with the flags given;
 * 4. checks that each workspace package taking a floors entry resolved exactly that version, and prints them. It reads
 *    each package's direct copy (`<package>/node_modules/<name>`) only: a second copy nested deeper in the tree, one a
 *    dependency brought in on another version, is not seen.
 *
 * What it leaves open is #112: no type-check against the floors' declarations (`@types/react` stays at the catalog's),
 * no peer check of the whole tree (`pnpm peers check`) beyond the direct copies above, and an unlocked install.
 *
 * It runs no test itself: the workflow runs each gate as its own step, with Playwright set up between them, so a red
 * run names the gate, and the commands stay the ones the other jobs run.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname, "..");
const WORKSPACE_FILE = "pnpm-workspace.yaml";
/** The named catalog that holds the floors; no package takes it. */
const FLOORS = "floors";
/** The name `pnpm config get catalogs` gives the top-level `catalog`. */
const DEFAULT = "default";

/** A command exited non-zero or could not start. */
class CommandFailed extends Error {
  readonly _tag = "CommandFailed" as const;
  readonly command: string;

  constructor(command: string, cause: unknown) {
    super(`${command} failed`, { cause });
    this.command = command;
  }
}

/** A file or a command's output did not have the shape the script reads. */
class UnexpectedFile extends Error {
  readonly _tag = "UnexpectedFile" as const;
  readonly file: string;

  constructor(file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.file = file;
  }
}

/** The checkout has changes the write would mix with its own. */
class DirtyCheckout extends Error {
  readonly _tag = "DirtyCheckout" as const;
  readonly changes: ReadonlyArray<string>;

  constructor(changes: ReadonlyArray<string>) {
    super(
      `the checkout has uncommitted changes, and this script rewrites ${WORKSPACE_FILE} and pnpm-lock.yaml; run it in a clean (scratch) checkout:\n${changes.join("\n")}`
    );
    this.changes = changes;
  }
}

/** A workspace package resolved another version than the floor, or no package takes a floors entry. */
class FloorNotResolved extends Error {
  readonly _tag = "FloorNotResolved" as const;
  readonly misses: ReadonlyArray<string>;

  constructor(misses: ReadonlyArray<string>) {
    super(`the install did not resolve every floor:\n${misses.join("\n")}`);
    this.misses = misses;
  }
}

type FloorsError = CommandFailed | UnexpectedFile | DirtyCheckout | FloorNotResolved;

type Result<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: FloorsError };

function ok<T>(value: T): Result<T> {
  return { _tag: "ok", value };
}

function err<T>(error: FloorsError): Result<T> {
  return { _tag: "err", error };
}

function run(command: string, args: ReadonlyArray<string>, output: "capture"): Result<string>;
function run(command: string, args: ReadonlyArray<string>, output: "stream"): Result<void>;
function run(
  command: string,
  args: ReadonlyArray<string>,
  output: "capture" | "stream"
): Result<string | void> {
  try {
    const stdout = execFileSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: output === "capture" ? ["ignore", "pipe", "inherit"] : "inherit",
    });

    // With stdout inherited, execFileSync returns null whatever its type says, so only a capture returns it.
    return ok(output === "capture" ? stdout : undefined);
  } catch (cause) {
    return err(new CommandFailed([command, ...args].join(" "), cause));
  }
}

/** What `pnpm config get catalogs --json` prints: each catalog by name (`default` for the top-level `catalog`), entry
 * name → version. */
type CatalogsJson = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** The entries of `pnpm ls --recursive --depth -1 --json` the script reads. */
type ProjectsJson = ReadonlyArray<{ readonly path: string }>;

/** The fields of a package.json the script reads. */
type Manifest = {
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
};

/**
 * One of the three JSON shapes above, from pnpm's own output or a package.json pnpm wrote or read. A field it lacks
 * reads as absent: every use compares a version to a floor or lists names, so a shape that differs fails a check.
 */
function parseJson<T extends CatalogsJson | ProjectsJson | Manifest>(
  source: string,
  text: string
): Result<T> {
  try {
    // SAFETY: the text is pnpm's JSON output or a package.json, of the shape T names (see above); no field is trusted
    // further than a comparison with a floor.
    return ok(JSON.parse(text) as T);
  } catch (cause) {
    return err(new UnexpectedFile(source, `unreadable JSON (${String(cause)})`));
  }
}

/** The catalogs as pnpm itself reads `pnpm-workspace.yaml`, so YAML's own syntax (quotes, comments) is pnpm's. */
function readCatalogs(): Result<CatalogsJson> {
  const output = run("pnpm", ["config", "get", "catalogs", "--json"], "capture");

  return output._tag === "ok" ? parseJson<CatalogsJson>("pnpm config get catalogs", output.value) : output;
}

/** A floors entry and the one other catalog entry it replaces. */
type Swap = {
  readonly name: string;
  readonly floor: string;
  readonly catalog: string;
  readonly from: string;
};

function planSwaps(catalogs: CatalogsJson): Result<ReadonlyArray<Swap>> {
  const floors = Object.entries(catalogs[FLOORS] ?? {});

  if (floors.length === 0) {
    return err(new UnexpectedFile(WORKSPACE_FILE, `no \`catalogs.${FLOORS}\` entries`));
  }

  const swaps: Array<Swap> = [];

  for (const [name, floor] of floors) {
    const targets = Object.entries(catalogs).flatMap(([catalog, entries]) => {
      const from = entries[name];

      return catalog === FLOORS || from === undefined ? [] : [{ name, floor, catalog, from }];
    });
    const [target] = targets;

    if (target === undefined || targets.length > 1) {
      return err(
        new UnexpectedFile(
          WORKSPACE_FILE,
          `the floors entry ${name} names ${targets.length} catalog entries; it replaces exactly one`
        )
      );
    }

    swaps.push(target);
  }

  return ok(swaps);
}

/** The catalogs with each floors version in place of the entry it replaces. */
function applySwaps(catalogs: CatalogsJson, swaps: ReadonlyArray<Swap>): CatalogsJson {
  return Object.fromEntries(
    Object.entries(catalogs).map(([catalog, entries]) => [
      catalog,
      {
        ...entries,
        ...Object.fromEntries(
          swaps.filter((swap) => swap.catalog === catalog).map(({ name, floor }) => [name, floor])
        ),
      },
    ])
  );
}

/** Writes the catalogs with pnpm's own YAML writer: the top-level `catalog` from `default`, the rest as `catalogs`. */
function writeCatalogs(catalogs: CatalogsJson): Result<void> {
  const { [DEFAULT]: catalog = {}, ...named } = catalogs;

  for (const [key, value] of [
    ["catalog", catalog],
    ["catalogs", named],
  ] as const) {
    const written = run(
      "pnpm",
      ["config", "set", "--location=project", "--json", key, JSON.stringify(value)],
      "stream"
    );

    if (written._tag === "err") {
      return written;
    }
  }

  return ok(undefined);
}

/** Each catalog entry as one `catalog name: version` line. */
function entryLines(catalogs: CatalogsJson): ReadonlySet<string> {
  return new Set(
    Object.entries(catalogs).flatMap(([catalog, entries]) =>
      Object.entries(entries).map(([name, version]) => `${catalog} ${name}: ${version}`)
    )
  );
}

/** Every catalog entry where the file as pnpm reads it after the write differs from the plan. */
function writeMisses(planned: CatalogsJson, written: CatalogsJson): ReadonlyArray<string> {
  const want = entryLines(planned);
  const got = entryLines(written);

  return [
    ...[...want].filter((line) => !got.has(line)).map((line) => `expected ${line}`),
    ...[...got].filter((line) => !want.has(line)).map((line) => `found ${line}`),
  ];
}

/** A package.json: its fields, or why it cannot be read or parsed as one, with its path. */
function readManifest(file: string): Result<Manifest> {
  let text: string;

  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    return err(new UnexpectedFile(file, `unreadable (${String(cause)})`));
  }

  return parseJson<Manifest>(file, text);
}

/** The workspace's package directories, the root included, as pnpm lists them. */
function workspaceDirectories(): Result<ReadonlyArray<string>> {
  const output = run("pnpm", ["ls", "--recursive", "--depth", "-1", "--json"], "capture");
  const json = output._tag === "ok" ? parseJson<ProjectsJson>("pnpm ls", output.value) : output;

  if (json._tag === "err") {
    return json;
  }

  const paths = json.value.map(({ path }) => path);

  return paths.length === 0 ? err(new UnexpectedFile("pnpm ls", "no workspace packages")) : ok(paths);
}

/** Each floors entry against every workspace package that takes it: the resolved lines, or every miss. */
function checkResolved(
  swaps: ReadonlyArray<Swap>,
  directories: ReadonlyArray<string>
): Result<ReadonlyArray<string>> {
  // A workspace package's own manifest that cannot be read would drop its floors from the check, so it fails the run.
  const takers: Array<{ readonly directory: string; readonly names: ReadonlySet<string> }> = [];

  for (const directory of directories) {
    const manifest = readManifest(join(directory, "package.json"));

    if (manifest._tag === "err") {
      return manifest;
    }

    const { dependencies, devDependencies, optionalDependencies } = manifest.value;
    takers.push({
      directory,
      names: new Set(Object.keys({ ...dependencies, ...devDependencies, ...optionalDependencies })),
    });
  }

  const misses: Array<string> = [];
  const resolved: Array<string> = [];

  for (const { name, floor } of swaps) {
    const consumers = takers.filter(({ names }) => names.has(name)).map(({ directory }) => directory);

    if (consumers.length === 0) {
      misses.push(`${name}: no workspace package takes it`);
    }

    for (const directory of consumers) {
      // An install that left no readable copy resolved nothing: a miss, not a failure of the check.
      const installed = readManifest(join(directory, "node_modules", name, "package.json"));
      const version = installed._tag === "ok" ? installed.value.version : undefined;

      if (version !== floor) {
        misses.push(`${directory}: ${name} resolved ${version ?? "nothing"}, not the floor ${floor}`);
      }
    }

    resolved.push(
      `${name} ${floor}: ${consumers.map((directory) => directory.slice(ROOT.length + 1) || ".").join(", ")}`
    );
  }

  return misses.length > 0 ? err(new FloorNotResolved(misses)) : ok(resolved);
}

function main(installFlags: ReadonlyArray<string>): Result<void> {
  const status = run("git", ["status", "--porcelain"], "capture");

  if (status._tag === "err") {
    return status;
  }

  const changes = status.value.split("\n").filter((line) => line !== "");

  if (changes.length > 0) {
    return err(new DirtyCheckout(changes));
  }

  const before = readCatalogs();

  if (before._tag === "err") {
    return before;
  }

  const swaps = planSwaps(before.value);

  if (swaps._tag === "err") {
    return swaps;
  }

  process.stdout.write(`peer-floors: rewriting ${WORKSPACE_FILE} and pnpm-lock.yaml in place:\n`);

  for (const { name, floor, catalog, from } of swaps.value) {
    const change = from === floor ? `${floor}, already the floor` : `${from} → ${floor}`;
    process.stdout.write(`  ${name}: ${change} (${catalog} catalog)\n`);
  }

  const planned = applySwaps(before.value, swaps.value);
  const written = writeCatalogs(planned);

  if (written._tag === "err") {
    return written;
  }

  const after = readCatalogs();

  if (after._tag === "err") {
    return after;
  }

  const misses = writeMisses(planned, after.value);

  if (misses.length > 0) {
    return err(
      new UnexpectedFile(
        WORKSPACE_FILE,
        `the write did not change exactly the floors' entries:\n${misses.join("\n")}`
      )
    );
  }

  const installed = run("pnpm", ["install", "--no-frozen-lockfile", ...installFlags], "stream");

  if (installed._tag === "err") {
    return installed;
  }

  const directories = workspaceDirectories();

  if (directories._tag === "err") {
    return directories;
  }

  const resolved = checkResolved(swaps.value, directories.value);

  if (resolved._tag === "err") {
    return resolved;
  }

  process.stdout.write(
    `peer-floors: every package resolved its floor:\n${resolved.value.map((line) => `  ${line}\n`).join("")}`
  );

  return ok(undefined);
}

const outcome = main(process.argv.slice(2));

if (outcome._tag === "err") {
  // The ::error:: workflow command turns the reason into an annotation on the Actions run; in a terminal it is a
  // harmless prefix.
  process.stdout.write(`::error::peer-floors: ${outcome.error._tag}: ${outcome.error.message}\n`);
  process.exitCode = 1;
}
