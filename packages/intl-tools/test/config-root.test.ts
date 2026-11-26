import * as NodePath from "@effect/platform-node-shared/NodePath";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import { existsSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { expect, test } from "vitest";

import { CatalogFiles } from "../src/catalog-files";
import { CliPlatform, cliProgram, exitCodeOf } from "../src/cli-run";
import type { IntlNextConfig } from "../src/next";
import { withIntl } from "../src/next";
import { catalogLocales } from "../src/project-catalogs";
import type { ConfigLoaded } from "../src/project-config";
import { loadConfig } from "../src/project-config";
import { readConfig, readConfigSnapshot } from "../src/project-config-read";
import { NodePlatform, projectServices } from "../src/project-services";
import { Reporter } from "../src/reporter";
import { CatalogSync } from "../src/watch";
import { FileEvents } from "../src/watch-trees";
import type { Project } from "./project-fixture";
import { openProject } from "./project-fixture";
import { syncFileSystem } from "./sync-file-system";

// Each test owns its project, at its real path (`openProject`), so every path below is the kernel's own spelling
// unless a link the test makes reaches it.
const it = test.extend("project", ({ task }, { onCleanup }) => {
  const { project, close } = openProject("elmera-intl-config-root-", task.timeout);
  onCleanup(close);

  return project;
});

const PAGE = `import { useT } from "@elmeragroup/intl/react";
export function Page() {
  const t = useT();
  return t("Hello");
}
`;

// The app's directory, and the two places a climbing `../messages` can name: where the kernel takes it from the app's
// real directory, and where it lands from the link's.
const APP = "repo/apps/web";
const MESSAGES = "repo/apps/messages/nb.po";
const AT_THE_LINK = "mnt/messages/nb.po";

type Layout = {
  // The `catalogs` pattern, given the project root.
  readonly catalogs: (root: string) => string;
  // Whether `elmera-intl.json` is a link to `configs/web.json`, a file in another directory.
  readonly configLink: boolean;
};

// The app's `elmera-intl.json` and its one source, with `mnt/web` a link to the app's directory: a link whose parent is
// not the parent of its target, so `..` from one reaches another directory than `..` from the other.
function writeApp(project: Project, layout: Layout): void {
  const config = JSON.stringify({
    include: ["src/**/*.tsx"],
    catalogs: layout.catalogs(project.root),
    locales: ["nb"],
  });
  project.write(`${APP}/src/page.tsx`, PAGE);
  mkdirSync(project.path("mnt"));
  symlinkSync(project.path(APP), project.path("mnt/web"), "dir");

  if (layout.configLink) {
    project.write("configs/web.json", config);
    symlinkSync(project.path("configs/web.json"), project.path(`${APP}/elmera-intl.json`), "file");
  } else {
    project.write(`${APP}/elmera-intl.json`, config);
  }
}

// `elmera-intl extract` in this process, from `cwd`, with `args` after the command, on `platform`: its exit code and
// what it printed on stderr (its stdout is not what is compared).
async function extract(
  project: Project,
  cwd: string,
  args: ReadonlyArray<string>,
  platform: Layer.Layer<FileSystem.FileSystem | Path.Path> = NodePlatform
): Promise<{ readonly code: number; readonly stderr: string }> {
  let stderr = "";
  const reporter = Reporter.layer({
    stdout: () => undefined,
    stderr: (text) => {
      stderr += text;
    },
  });
  const exit = await project.within(
    Effect.runPromiseExit(
      cliProgram(["extract", ...args], { cwd }).pipe(
        Effect.provide([
          CliPlatform,
          reporter,
          Layer.provideMerge(CatalogSync.layer(), projectServices(CatalogFiles.layer(), platform)),
          FileEvents.layer(),
        ])
      )
    ),
    `elmera-intl extract ${args.join(" ")}`
  );

  return { code: exitCodeOf(exit), stderr };
}

const EXTRACTED = { code: 0, stderr: "" };

// What a Turbopack rule holds: conditions, loader options and paths.
type RuleValue =
  | RegExp
  | ReadonlyArray<RuleValue>
  | { readonly [field: string]: RuleValue }
  | string
  | boolean
  | null;

// The path condition of every rule withIntl adds, read through the rule map it returns (opaque to its types).
function rulePaths(config: IntlNextConfig): ReadonlyArray<RegExp> {
  const found: Array<RegExp> = [];
  JSON.stringify(config.turbopack?.rules, (_key: string, value: RuleValue): RuleValue => {
    if (value instanceof RegExp) {
      found.push(value);
    }

    return value;
  });

  return found;
}

function rootOf(loaded: ConfigLoaded): string {
  if (loaded._tag !== "Config") {
    throw new Error(loaded.problem.message);
  }

  return loaded.config.root;
}

// Unit under test: where each reader of one `elmera-intl.json` puts its catalogs, however the path to it is spelled
// (#75): the config reads (`loadConfig`, which withIntl and the loaders run, and the Effect `readConfig` and
// `readConfigSnapshot`, which the CLI and the watch run), `elmera-intl extract` (the catalog it writes), withIntl's
// Turbopack rule (the catalog paths below the root it matches) and the locale the catalog import compiles the written
// catalog for (`catalogLocales`, which Next's loader and Vite's `load` share). Oracle: the layout itself. The config's
// root is the directory its path names, at its real path, `repo/apps/web`, also when the path is a link to a file in
// another directory (#52's repoints, #53's replay rows c1 and c2); its `../messages` and an absolute pattern climbing
// out of `mnt/web` both land where the kernel takes `..` from that directory, `repo/apps/messages`, never beside the
// link, `mnt/messages`.
it.for([
  {
    name: "the config's directory reached through a link, extracting from the app's real directory",
    layout: { catalogs: () => "../messages/{locale}.po", configLink: false },
    spelled: "mnt/web/elmera-intl.json",
    cli: { cwd: APP, args: [] },
  },
  {
    name: "the config's directory reached through a link, extracting with --config through it",
    layout: { catalogs: () => "../messages/{locale}.po", configLink: false },
    spelled: "mnt/web/elmera-intl.json",
    cli: { cwd: ".", args: ["--config", "mnt/web/elmera-intl.json"] },
  },
  {
    name: "a symlinked elmera-intl.json whose target is in another directory",
    layout: { catalogs: () => "../messages/{locale}.po", configLink: true },
    spelled: `${APP}/elmera-intl.json`,
    cli: { cwd: APP, args: [] },
  },
  {
    name: "an absolute catalogs pattern climbing out of a link",
    // Spelled out, not joined: `join` would collapse the `..` before the config holds it.
    layout: { catalogs: (root: string) => `${root}/mnt/web/../messages/{locale}.po`, configLink: false },
    spelled: `${APP}/elmera-intl.json`,
    cli: { cwd: APP, args: [] },
  },
])(
  "roots $name at the real directory, and every reader agrees",
  async ({ layout, spelled, cli }, { project }) => {
    writeApp(project, layout);
    const config = project.path(spelled);
    const reads = await Effect.runPromise(
      Effect.all([readConfig(config), readConfigSnapshot(config)]).pipe(Effect.provide(NodePlatform))
    );
    const extracted = await extract(project, project.path(cli.cwd), cli.args);
    const loaded = loadConfig(config);
    const rule = rulePaths(
      withIntl({ turbopack: { root: project.root } }, { dir: dirname(config) })("phase-production-build")
    );

    expect({
      extracted,
      roots: [rootOf(loaded), rootOf(reads[0]), rootOf(reads[1].loaded)],
      written: [MESSAGES, AT_THE_LINK].filter((catalog) => existsSync(project.path(catalog))),
      matched: rule.map((path) => [MESSAGES, AT_THE_LINK].filter((catalog) => path.test(catalog))),
      locale: loaded._tag === "Config" ? catalogLocales(loaded.config, project.path(MESSAGES)) : undefined,
    }).toEqual({
      extracted: EXTRACTED,
      roots: [project.path(APP), project.path(APP), project.path(APP)],
      written: [MESSAGES],
      matched: [[MESSAGES], [MESSAGES]],
      locale: ["nb"],
    });
  }
);

// Two checkouts of one app, each with its own config, and `current` a link to the first: a deploy's repoint of
// `current` moves every read through it from one to the other.
const CHECKOUTS = { a: ["nb"], b: ["sv"] } as const;
const CATALOGS = ["a/messages/nb.po", "a/messages/sv.po", "b/messages/nb.po", "b/messages/sv.po"];

// A checkout's config, as its file holds it.
function checkoutConfig(checkout: keyof typeof CHECKOUTS): string {
  return JSON.stringify({
    include: ["src/**/*.tsx"],
    catalogs: "messages/{locale}.po",
    locales: CHECKOUTS[checkout],
  });
}

function writeCheckouts(project: Project): void {
  for (const checkout of ["a", "b"] as const) {
    project.write(`${checkout}/src/page.tsx`, PAGE);
    project.write(`${checkout}/elmera-intl.json`, checkoutConfig(checkout));
  }
}

// `current` repointed as `ln -sfn` repoints it: unlinked, then linked again.
function unlinkCurrent(project: Project): void {
  if (existsSync(project.path("current"))) {
    unlinkSync(project.path("current"));
  }
}

function pointCurrent(project: Project, checkout: keyof typeof CHECKOUTS): void {
  unlinkCurrent(project);
  symlinkSync(project.path(checkout), project.path("current"), "dir");
}

// The checkout `current` links to.
function currentCheckout(project: Project): string {
  return basename(readlinkSync(project.path("current")));
}

// Unit under test: one read of a config, by `extract` (`readConfig`) and by the watch (`readConfigSnapshot`), when
// `current` is repointed from `a` to `b` while the read looks up the config's directory (#75): on entry to that lookup,
// before it resolves; right after it resolves; or in the gap of a repoint that unlinks first (`ln -sfn`), so the
// lookup finds no `current`, with the link back at `b` before the read. Oracle: the layout itself. A read returns the
// text and the root of one directory, so the catalogs written are the ones that directory's config names, in that
// directory: `b`'s `sv` in `b` when the repoint precedes the lookup, `a`'s `nb` in `a` when it follows it, never one
// checkout's locale in the other's directory. A lookup that finds no directory reads no file, so neither reads `b`'s
// config through the link that came back: the config is "not found", in the caller's spelling, as a missing one is,
// and nothing is written. Each read moves the link to `b`, so no row passes on a repoint that never fired.
// `loadConfig` reads through `node:fs` itself, with no seam to repoint in; it shares the rule that names the file in
// the resolved directory (`configIn`) and reads nothing when the directory does not resolve.
it.for([
  { repoint: "before", checkout: "b", written: ["b/messages/sv.po"] },
  { repoint: "after", checkout: "a", written: ["a/messages/nb.po"] },
  { repoint: "in the gap of", checkout: undefined, written: [] },
] as const)(
  "reads the config and its root from one directory when current is repointed $repoint the lookup",
  async ({ repoint, checkout, written }, { project }) => {
    writeCheckouts(project);
    let armed = false;
    // The file system, its lookup of `current`'s real path repointing `current` at `b` once, when armed.
    const fileSystem = syncFileSystem({
      realPath: (resolve) => (path) => {
        if (!armed || path !== project.path("current")) {
          return resolve(path);
        }

        armed = false;

        if (repoint === "before") {
          pointCurrent(project, "b");

          return resolve(path);
        }

        if (repoint === "after") {
          return resolve(path).pipe(Effect.tap(() => Effect.sync(() => pointCurrent(project, "b"))));
        }

        unlinkCurrent(project);

        return resolve(path).pipe(Effect.ensuring(Effect.sync(() => pointCurrent(project, "b"))));
      },
    });
    const platform = Layer.merge(fileSystem, NodePath.layer);
    const config = project.path("current/elmera-intl.json");

    pointCurrent(project, "a");
    armed = true;
    const extracted = await extract(project, project.root, ["--config", config], platform);
    const afterExtract = currentCheckout(project);
    pointCurrent(project, "a");
    armed = true;
    const snapshot = await Effect.runPromise(readConfigSnapshot(config).pipe(Effect.provide(platform)));

    expect({
      extracted: { code: extracted.code, problem: extracted.stderr.split("\n")[0] },
      written: CATALOGS.filter((catalog) => existsSync(project.path(catalog))),
      current: [afterExtract, currentCheckout(project)],
      text: snapshot.text,
      watch:
        snapshot.loaded._tag === "Config"
          ? { locales: snapshot.loaded.config.locales, root: snapshot.loaded.config.root }
          : snapshot.loaded.problem.message,
    }).toEqual(
      checkout === undefined
        ? {
            extracted: { code: 1, problem: `${config}: ConfigInvalid: ${config} not found` },
            written,
            current: ["b", "b"],
            text: undefined,
            watch: `${config} not found`,
          }
        : {
            extracted: { code: 0, problem: "" },
            written,
            current: ["b", "b"],
            text: checkoutConfig(checkout),
            watch: { locales: CHECKOUTS[checkout], root: project.path(checkout) },
          }
    );
  }
);

// Whether a path exists with every segment spelled as the directory holding it lists it: on a case-insensitive volume
// `existsSync` finds a file under any case of its name.
function existsAsSpelled(project: Project, path: string): boolean {
  let directory = project.root;

  return path.split("/").every((segment) => {
    const found = existsSync(directory) && readdirSync(directory).includes(segment);
    directory = join(directory, segment);

    return found;
  });
}

// Whether the project's volume folds case: a file written under one case found under another.
function foldsCase(project: Project): boolean {
  project.write("case-probe", "");

  return existsSync(project.path("CASE-PROBE"));
}

const NESTED_CONFIG = JSON.stringify({
  include: ["src/**/*.tsx"],
  catalogs: "../messages/{locale}.po",
  locales: ["nb"],
});

// Unit under test: the config's root, as every reader takes it, where Node's JavaScript `realpath` and the kernel part
// (#75's real-path policy for a root): the config reads (`loadConfig`, `readConfig`, `readConfigSnapshot`), the catalog
// `extract` writes, withIntl's rule and the catalog import's locale. Oracle: the kernel's answer, which Next
// (lib/realpath.js) and Vite (`safeRealpathSync`) take on POSIX, `fs.realpathSync.native`, stated for each layout:
// - a link whose target climbs with `..` through a second link (#118): `mnt/web -> ../checkout/current/../web`, with
//   `checkout/current -> ../releases/active`, is `releases/web`, as the kernel takes `..` from `releases/active`;
//   Node's JavaScript `realpath` collapses `current/..` first and finds no `checkout/web`;
// - a directory spelled in another case than its own (`myapp` for `MyApp`), on a volume that folds case: `MyApp`,
//   where the JavaScript `realpath` keeps the spelling it was given.
it.for([
  {
    name: "a link whose target climbs with .. through a second link",
    layout: (project: Project) => {
      project.write("releases/web/src/page.tsx", PAGE);
      project.write("releases/web/elmera-intl.json", NESTED_CONFIG);
      mkdirSync(project.path("releases/active"));
      mkdirSync(project.path("checkout"));
      mkdirSync(project.path("mnt"));
      symlinkSync("../releases/active", project.path("checkout/current"), "dir");
      symlinkSync("../checkout/current/../web", project.path("mnt/web"), "dir");
    },
    foldsCase: false,
    spelled: "mnt/web/elmera-intl.json",
    root: "releases/web",
    catalogs: ["releases/messages/nb.po", "mnt/messages/nb.po", "checkout/messages/nb.po"],
  },
  {
    name: "a directory spelled in another case than its own",
    layout: (project: Project) => {
      project.write("MyApp/src/page.tsx", PAGE);
      project.write(
        "MyApp/elmera-intl.json",
        JSON.stringify({ include: ["src/**/*.tsx"], catalogs: "messages/{locale}.po", locales: ["nb"] })
      );
    },
    foldsCase: true,
    spelled: "myapp/elmera-intl.json",
    root: "MyApp",
    catalogs: ["MyApp/messages/nb.po", "myapp/messages/nb.po"],
  },
])(
  "roots $name at the kernel's real path",
  async ({ layout, foldsCase: folding, spelled, root, catalogs }, { project, skip }) => {
    skip(
      folding && !foldsCase(project),
      "the volume is case-sensitive (Linux CI): no other spelling of MyApp reaches it"
    );
    layout(project);
    const config = project.path(spelled);
    const reads = await Effect.runPromise(
      Effect.all([readConfig(config), readConfigSnapshot(config)]).pipe(Effect.provide(NodePlatform))
    );
    const extracted = await extract(project, project.root, ["--config", config]);
    const loaded = loadConfig(config);
    const rule = rulePaths(
      withIntl({ turbopack: { root: project.root } }, { dir: dirname(config) })("phase-production-build")
    );
    const [catalog = ""] = catalogs;

    expect({
      extracted,
      roots: [rootOf(loaded), rootOf(reads[0]), rootOf(reads[1].loaded)],
      written: catalogs.filter((path) => existsAsSpelled(project, path)),
      matched: rule.map((path) => catalogs.filter((path_) => path.test(path_))),
      locale: loaded._tag === "Config" ? catalogLocales(loaded.config, project.path(catalog)) : undefined,
    }).toEqual({
      extracted: EXTRACTED,
      roots: [project.path(root), project.path(root), project.path(root)],
      written: [catalog],
      matched: [[catalog], [catalog]],
      locale: ["nb"],
    });
  }
);
