// The contracts that live in JSON and YAML, which oxlint does not read: package manifests, the dependency catalog, the
// Node pin and the lint config itself. Fast and unbuilt, so it runs in the same feedback loop as lint.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { parseFileCopies } from "../src/workspace.ts";
import {
  catalogEntries,
  effectPresetFindings,
  lintConfigFindings,
  parseJsonc,
  ruleSetting,
} from "./config-files.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

type Manifest = {
  readonly name: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly sideEffects?: boolean;
  readonly files?: ReadonlyArray<string>;
  readonly bin?: Readonly<Record<string, string>>;
  readonly exports?: Readonly<Record<string, ExportTarget>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly publishConfig?: { readonly access?: string };
  readonly devEngines?: { readonly runtime?: { readonly version?: string } };
  readonly scripts?: Readonly<Record<string, string>>;
};
type ExportTarget = string | { readonly [condition: string]: ExportTarget };

// SAFETY: the workspace's own manifests, committed and read by pnpm on every install; the assertions below check
// each field they use.
const parseManifest = (path: string): Manifest => JSON.parse(read(path)) as Manifest;

// The directories pnpm-workspace.yaml's `packages` globs (`dir/*`) name, holding a package.json.
const WORKSPACE: unknown = parseYaml(read("pnpm-workspace.yaml"));
const WORKSPACE_GLOBS = (
  typeof WORKSPACE === "object" &&
  WORKSPACE !== null &&
  "packages" in WORKSPACE &&
  Array.isArray(WORKSPACE.packages)
    ? WORKSPACE.packages.map(String)
    : []
).map((glob) => glob.replace(/\/\*$/u, ""));
const PACKAGES = WORKSPACE_GLOBS.flatMap((dir) =>
  existsSync(join(ROOT, dir))
    ? readdirSync(join(ROOT, dir))
        .map((name) => `${dir}/${name}`)
        .filter((path) => existsSync(join(ROOT, path, "package.json")))
    : []
).map((path) => ({ path, manifest: parseManifest(`${path}/package.json`) }));
const PUBLISHED = PACKAGES.filter(({ manifest }) => manifest.private !== true);
const APPS = PACKAGES.filter(({ path }) => path.startsWith("apps/"));

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

// Every entry in the given manifests that links an app: by its key, by the package its specifier aliases
// (`workspace:<name>@<range>`, `npm:<name>@<range>`), or by the directory its specifier points at (`link:` or `file:`
// and a path, or `workspace:` and a relative one). Each section is read on its own: a key may appear in several, and
// one section's entry must not hide another's.
function appDependents(
  manifests: ReadonlyArray<{ readonly dir: string; readonly manifest: Manifest }>
): Array<string> {
  const names = new Set(APPS.map(({ manifest }) => manifest.name));
  const directories = APPS.map(({ path }) => path);
  const linksApp = (dir: string, name: string, spec: string): boolean => {
    const alias = /^(?:workspace|npm):(@?[^@]+)@/u.exec(spec)?.[1];
    // `link:` and `file:` always name a path; `workspace:` only when it starts like one (`workspace:*` is a range).
    const target = /^(?:link|file):(.+)$/u.exec(spec)?.[1] ?? /^workspace:(\.{0,2}\/.*)$/u.exec(spec)?.[1];
    const targetDir = target === undefined ? undefined : relative(ROOT, resolve(ROOT, dir, target));

    return (
      names.has(name) ||
      (alias !== undefined && names.has(alias)) ||
      (targetDir !== undefined &&
        directories.some((app) => targetDir === app || targetDir.startsWith(`${app}/`)))
    );
  };

  return manifests.flatMap(({ dir, manifest }) =>
    DEPENDENCY_SECTIONS.flatMap((section) =>
      Object.entries(manifest[section] ?? {})
        .filter(([name, spec]) => linksApp(dir, name, spec))
        .map(([name, spec]) => `${dir || "."}/package.json ${section} → ${name}: ${spec}`)
    )
  );
}

// Conditions Node, TypeScript and the bundlers define; any other is ours, in a global namespace.
const STANDARD_CONDITIONS = new Set([
  "types",
  "import",
  "require",
  "default",
  "node",
  "browser",
  "react-server",
]);

function conditionsOf(target: ExportTarget): ReadonlyArray<string> {
  return typeof target === "string"
    ? []
    : Object.entries(target).flatMap(([condition, value]) => [condition, ...conditionsOf(value)]);
}

function sourceTargets(target: ExportTarget): ReadonlyArray<string> {
  return typeof target === "string"
    ? []
    : Object.entries(target).flatMap(([condition, value]) =>
        condition === "elmera-source" && typeof value === "string"
          ? [value]
          : condition === "elmera-source" && typeof value !== "string"
            ? Object.values(value).filter((nested): nested is string => typeof nested === "string")
            : sourceTargets(value)
      );
}

// Unit under test: the committed workspace configuration. Oracle: the conventions AGENTS.md states, each case naming
// the one it checks.
describe("workspace packages", () => {
  it("finds the published packages", () => {
    expect(PUBLISHED.map(({ manifest }) => manifest.name).toSorted()).toEqual([
      "@elmeragroup/intl",
      "@elmeragroup/intl-tools",
    ]);
  });

  // The published packages release as one: `.changeset/config.json`'s one fixed group holds exactly them.
  it("puts exactly the published packages in one changeset fixed group", () => {
    const config = parseJsonc(read(".changeset/config.json"));
    const fixed =
      typeof config === "object" && config !== null && "fixed" in config ? config.fixed : undefined;

    expect(fixed).toEqual([PUBLISHED.map(({ manifest }) => manifest.name).toSorted()]);
  });

  it.each(PACKAGES)("$path takes every dependency from the catalog or the workspace", ({ manifest }) => {
    const specs = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies });

    expect(specs.filter(([, spec]) => !/^(catalog:[\w-]*|workspace:\*)$/u.test(spec))).toEqual([]);
  });
});

// The apps (AGENTS.md, Package responsibilities), the examples and the docs site: leaves of the dependency graph that
// consume the packages as an app does, and never publish.
describe("apps", () => {
  it("finds the apps", () => {
    expect(APPS.map(({ path }) => path).toSorted()).toEqual([
      "apps/docs",
      "apps/effect-example",
      "apps/next-example",
      "apps/start-example",
    ]);
  });

  // Every manifest that can declare a dependency: each workspace package's and the root's.
  it("depends on no app", () => {
    const manifests = [
      { dir: "", manifest: parseManifest("package.json") },
      ...PACKAGES.map(({ path, manifest }) => ({ dir: path, manifest })),
    ];

    expect(appDependents(manifests)).toEqual([]);
  });

  // The guard itself, on a manifest pnpm would accept: one section's entry must not hide another's under the same key.
  it("finds an app linked in one section behind the same key in another", () => {
    const manifest = {
      name: "@elmeragroup/fixture",
      devDependencies: { alias: "link:./apps/next-example" },
      peerDependencies: { alias: "*" },
    };

    expect(appDependents([{ dir: "", manifest }])).toEqual([
      "./package.json devDependencies → alias: link:./apps/next-example",
    ]);
  });

  // "Ours" is a package this workspace holds; another @elmeragroup package (Fuse, the design system the apps are built
  // on) comes from npm through the catalog, as any other dependency does.
  const WORKSPACE_NAMES = new Set(PACKAGES.map(({ manifest }) => manifest.name));

  it.each(APPS)(
    "$path is private, named @elmeragroup/<directory>, and takes our packages from the workspace",
    ({ path, manifest }) => {
      const ours = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).filter(
        ([name]) => WORKSPACE_NAMES.has(name)
      );

      expect(manifest.private).toBe(true);
      expect(manifest.name).toBe(`@elmeragroup/${path.slice("apps/".length)}`);
      expect(ours.filter(([, spec]) => spec !== "workspace:*")).toEqual([]);
    }
  );
});

describe.each(PUBLISHED)("published $manifest.name", ({ path, manifest }) => {
  it("is side-effect free, public, and ships its license, notice and readme", () => {
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.publishConfig?.access).toBe("public");
    expect(manifest.files).toEqual(expect.arrayContaining(["dist", "LICENSE", "NOTICE", "README.md"]));

    for (const file of ["LICENSE", "NOTICE", "README.md"]) {
      expect(existsSync(join(ROOT, path, file)), file).toBe(true);
    }
  });

  it("versions with the other published package", () => {
    expect(new Set(PUBLISHED.map((pkg) => pkg.manifest.version))).toEqual(new Set([manifest.version]));
  });

  it("imports no @elmeragroup package but the runtime", () => {
    const names = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });

    expect(names.filter((name) => name.startsWith("@elmeragroup/") && name !== "@elmeragroup/intl")).toEqual(
      []
    );
  });

  // The source condition comes first, so TypeScript and Node reach src before `types`; then `types` before the
  // runtime target, which TypeScript requires.
  it.each(Object.entries(manifest.exports ?? {}))(
    "maps %s to existing source, then types",
    (_subpath, target) => {
      const branches = typeof target === "string" ? [] : [target, ...Object.values(target)];

      for (const branch of branches.filter((value) => typeof value !== "string")) {
        const keys = Object.keys(branch).filter((key) => key !== "react-server");

        if (keys.includes("elmera-source")) {
          expect(keys[0]).toBe("elmera-source");
        }

        if (keys.includes("types")) {
          expect(keys.find((key) => key !== "elmera-source")).toBe("types");
        }
      }

      const sources = sourceTargets(target);

      expect(sources.length).toBeGreaterThan(0);

      for (const source of sources) {
        expect(existsSync(join(ROOT, path, source)), source).toBe(true);
      }
    }
  );

  it("names its bins and its own export conditions in the elmera- namespace", () => {
    const ours = Object.values(manifest.exports ?? {})
      .flatMap((target) => conditionsOf(target))
      .filter((condition) => !STANDARD_CONDITIONS.has(condition));

    expect(Object.keys(manifest.bin ?? {}).filter((bin) => !bin.startsWith("elmera-"))).toEqual([]);
    expect(ours.filter((condition) => !condition.startsWith("elmera-"))).toEqual([]);
  });

  // Lint holds each entry module to its subpath's list; this holds the list of subpaths to the export map, both ways.
  it("commits a surface for exactly its public subpaths", () => {
    const surface = parseJsonc(read(`${path}/test/public-surface.json`));
    const committed = typeof surface === "object" && surface !== null ? Object.keys(surface) : [];
    const exported = Object.keys(manifest.exports ?? {}).filter(
      (subpath) => !subpath.startsWith("./internal/")
    );

    expect(committed.toSorted()).toEqual(exported.toSorted());
  });

  it("emits declarations from src only", () => {
    expect(parseJsonc(read(`${path}/tsconfig.build.json`))).toHaveProperty("include", ["src"]);
  });
});

describe("catalog", () => {
  const entries = catalogEntries(read("pnpm-workspace.yaml"));

  it("pins every version exactly", () => {
    expect(entries.length).toBeGreaterThan(20);
    expect(entries.filter(({ version }) => !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/u.test(version))).toEqual([]);
  });
});

describe("toolchain pins", () => {
  it("pins one Node version in .node-version and devEngines", () => {
    expect(parseManifest("package.json").devEngines?.runtime?.version).toBe(read(".node-version").trim());
  });

  // The docs images run on the base image their NODE_VERSION names, which nothing else reads.
  it.each(["apps/docs/Dockerfile", "apps/docs/placeholder/Dockerfile"])(
    "builds %s on the same Node",
    (path) => {
      const versions = [...read(path).matchAll(/^ARG NODE_VERSION=(\S+)$/gmu)].map((match) => match[1]);

      expect(versions).toEqual([read(".node-version").trim()]);
    }
  );
});

describe(".oxlintrc.json", () => {
  const config = read(".oxlintrc.json");
  const findings = lintConfigFindings(config);

  it("says what it means: every rule is an error or off", () => {
    expect(findings.warned).toEqual([]);
  });

  // An `off` names the contract it guards: a comment above it, or above the run of `off` rules it belongs to; in an
  // override, the override's own comment.
  it("explains every rule it turns off", () => {
    expect(findings.unexplainedOffs).toEqual([]);
  });

  // A file-scoped override (its files are paths, not globs) says why that file is the boundary that needs it.
  it("explains every file-scoped override", () => {
    expect(findings.unexplainedOverrides).toEqual([]);
  });

  it("parses", () => {
    expect(parseJsonc(config)).toHaveProperty("rules");
  });

  // Unit under test: the setting .oxlintrc.json gives elmera-workspace/file-copies, parsed by the rule's own
  // parseFileCopies, so this checks exactly the paths the rule matches. Oracle: the setting must be `error`, and the file
  // system, by realpath: it gives back a path unchanged only when the file exists under that exact spelling with no
  // symlink on the way (a case-only alias or a symlinked directory resolves elsewhere, a missing file throws). The rule
  // holds the copies' content, and runs only when on and only on linted files whose paths match these; a level turned
  // off or a mistyped path switches it off without a report, and a linked copy resolves its imports from the original's
  // place, so the setting is held here.
  it("holds each file elmera-workspace/file-copies names to a real file at its exact path, as an error", () => {
    const setting = ruleSetting(config, "elmera-workspace/file-copies");

    assert(setting !== undefined, "elmera-workspace/file-copies is not set in .oxlintrc.json's rules");
    expect(setting.level, "elmera-workspace/file-copies' level").toBe("error");

    const option = parseFileCopies(setting.options);

    if (option._tag === "Invalid") {
      assert.fail(`elmera-workspace/file-copies' option is invalid: ${option.reason}`);
    }

    const root = realpathSync.native(ROOT);
    const problems = [option.files.original, ...option.files.copies].flatMap((path) => {
      const configured = join(root, path);

      try {
        const resolved = realpathSync.native(configured);

        if (resolved !== configured) {
          return [`${path} resolves to ${relative(root, resolved)}`];
        }

        return statSync(resolved).isFile() ? [] : [`${path} is not a regular file`];
      } catch (error) {
        return [`${path} does not resolve: ${String(error)}`];
      }
    });

    expect(problems).toEqual([]);
  });
});

// The Effect diagnostics are configured twice: tooling/typescript/effect.json for the editor (the Effect language
// service) and .oxlintrc.effect.json for `pnpm lint:effect`, the gate, whose rules exist only in the Effect-patched
// oxlint. These hold the two to one decision per rule, and the gate to the main pass's scope.
type EffectPreset = {
  readonly compilerOptions: {
    readonly plugins: ReadonlyArray<{ readonly diagnosticSeverity: Readonly<Record<string, string>> }>;
  };
};
type EffectLintConfig = {
  readonly ignorePatterns: ReadonlyArray<string>;
  readonly rules: Readonly<Record<string, string>>;
};
type EffectSchema = {
  readonly definitions: {
    readonly effectLanguageServicePluginDiagnosticSeverityDefinition: {
      readonly properties: Readonly<Record<string, { readonly description: string }>>;
    };
  };
};

describe("Effect diagnostics", () => {
  const presetText = read("tooling/typescript/effect.json");
  const lintText = read(".oxlintrc.effect.json");
  // SAFETY: the committed preset and Effect lint config, and the installed @effect/tsgo's schema; a missing field fails
  // the case that reads it.
  const severities =
    (parseJsonc(presetText) as EffectPreset).compilerOptions.plugins[0]?.diagnosticSeverity ?? {};
  // SAFETY: as above.
  const lintConfig = parseJsonc(lintText) as EffectLintConfig;
  // The oxlint name of a language-service rule (each rule's docs list both): kebab case under `effecttsgo/`.
  const oxlintName = (rule: string) =>
    `effecttsgo/${rule.replace("UUID", "Uuid").replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;

  it("decides every rule in the preset: an error, or off with its reason", () => {
    expect(effectPresetFindings(presetText)).toEqual({ unclear: [], unexplainedOffs: [] });
  });

  // A bump of @effect/tsgo that adds a rule fails here until the preset decides it; a deprecated rule is left unnamed,
  // since naming one, even off, raises a warning of its own.
  it("names every rule of the installed @effect/tsgo but the deprecated ones", () => {
    // SAFETY: as above.
    const schema = JSON.parse(read("node_modules/@effect/tsgo/schema.json")) as EffectSchema;
    const current = Object.entries(
      schema.definitions.effectLanguageServicePluginDiagnosticSeverityDefinition.properties
    )
      .filter(([, rule]) => !rule.description.startsWith("Deprecated"))
      .map(([name]) => name);

    expect(Object.keys(severities).toSorted()).toEqual(current.toSorted());
  });

  it("gates exactly the preset's errors, as errors", () => {
    const errors = Object.entries(severities)
      .filter(([, level]) => level === "error")
      .map(([rule]) => oxlintName(rule));

    expect(Object.keys(lintConfig.rules).toSorted()).toEqual(errors.toSorted());
    expect(new Set(Object.values(lintConfig.rules))).toEqual(new Set(["error"]));
    expect(lintConfigFindings(lintText)).toEqual({
      warned: [],
      unexplainedOffs: [],
      unexplainedOverrides: [],
    });
  });

  // effect-tsgo falls back silently to its newest packaged tsrs when the installed one is not supported, so the gate
  // names its tsrs, and that is the catalog's.
  it("lints with the catalog's tsrs", () => {
    const tsrs = catalogEntries(read("pnpm-workspace.yaml")).find(({ name }) => name === "tsrs")?.version;
    const script = parseManifest("package.json").scripts?.["lint:effect"];

    expect(script).toContain(`--tsrs-lint=${String(tsrs)} `);
  });

  // The Effect pass lints the whole workspace, as the main pass does: a file that only consumes Effect values (yields
  // CurrentIntl, names an effect type through import()) needs the rules as much as one that imports effect. Both
  // passes skip the same paths.
  it("ignores what the main pass ignores", () => {
    // SAFETY: the committed main lint config; a missing field fails the comparison.
    const main = parseJsonc(read(".oxlintrc.json")) as Pick<EffectLintConfig, "ignorePatterns">;

    expect(lintConfig.ignorePatterns).toEqual(main.ignorePatterns);
  });
});
