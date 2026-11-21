// Builds both fixtures per pass, then runs the Playwright gates on that pass's builds; the linked pass also runs them on
// the dev servers (with the dev-loop specs) and proves a missing PO fails each build. Only ports 3020 (Next) and 3021
// (Start) are the fixtures', so two passes' servers cannot run side by side. The linked pass consumes the
// workspace-linked packages, as the apps do. The packed pass installs `pnpm pack` of packages/intl and
// packages/intl-tools into each fixture as real copies, as npm users get them: bundlers treat an installed package
// differently from a linked one (Vite's SSR externalizes it), and a file missing from either tarball fails there.
import type { SpawnSyncReturns } from "node:child_process";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import toolsManifest from "../../intl-tools/package.json" with { type: "json" };
import runtimeManifest from "../../intl/package.json" with { type: "json" };

const RUNTIMES = ["linked", "packed"] as const;
const FIXTURES = ["next", "start"] as const;
const root = fileURLToPath(new URL("../", import.meta.url));
// Each package, its workspace source, and a module of it every fixture resolves.
const toolsSource = fileURLToPath(new URL("../../intl-tools/", import.meta.url));
const PACKAGES = [
  {
    manifest: runtimeManifest,
    source: fileURLToPath(new URL("../../intl/", import.meta.url)),
    probe: "/react",
  },
  { manifest: toolsManifest, source: toolsSource, probe: "/vite" },
] as const;
const bin = (name: string) => fileURLToPath(new URL(`../node_modules/.bin/${name}`, import.meta.url));
const fixtureDir = (fixture: string) => `${root}fixtures/${fixture}`;
const installed = (fixture: string, name: string) => `${fixtureDir(fixture)}/node_modules/${name}`;

function run(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>>
): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// A leftover copy would turn later linked runs, and the fixtures' type-check, into packed ones.
function uninstallPacked(): void {
  FIXTURES.forEach((fixture) => {
    PACKAGES.forEach(({ manifest }) => {
      rmSync(installed(fixture, manifest.name), { recursive: true, force: true });
    });
  });
}

// Each tarball's contents as a real directory. Third-party dependencies link to the workspace's copies; a dependency
// on the other packed package (intl-tools on intl) resolves to that copy, beside it in the fixture's node_modules.
// Peers (react, next, the router, vite) resolve through this package as the fixtures' own do.
function installPacked(): void {
  const packDir = mkdtempSync(join(tmpdir(), "intl-pack-"));
  PACKAGES.forEach(({ manifest, source }, index) => {
    const tarball = join(packDir, `${index}.tgz`);
    run("pnpm", ["pack", "--out", tarball], source, {});
    FIXTURES.forEach((fixture) => {
      const target = installed(fixture, manifest.name);
      mkdirSync(target, { recursive: true });
      run("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"], root, {});
      Object.keys(manifest.dependencies)
        .filter((name) => !PACKAGES.some((other) => other.manifest.name === name))
        .forEach((name) => {
          const link = join(target, "node_modules", name);
          mkdirSync(dirname(link), { recursive: true });
          symlinkSync(realpathSync(join(source, "node_modules", name)), link);
        });
    });
  });
  rmSync(packDir, { recursive: true, force: true });
}

// A plain build behaves the same on either install, so the pass proves which copy it built against: every package
// resolves inside the fixture exactly when packed.
function assertResolution(runtime: (typeof RUNTIMES)[number]): void {
  FIXTURES.forEach((fixture) => {
    PACKAGES.forEach(({ manifest, probe }) => {
      const specifier = `${manifest.name}${probe}`;
      const url = execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`],
        { cwd: fixtureDir(fixture), encoding: "utf8" }
      ).trim();
      const inFixture = fileURLToPath(url).startsWith(`${fixtureDir(fixture)}${sep}node_modules${sep}`);

      if (inFixture !== (runtime === "packed")) {
        process.stderr.write(`${fixture}: ${specifier} resolved to ${url} in the ${runtime} pass\n`);
        process.exit(1);
      }
    });
  });
}

// A missing catalog must fail the build (R2-5): each fixture's build runs with its PO moved away. The Next build runs
// without `elmera-intl check`, so its loader rule's import fails; the Start build's check fails first (CatalogMissing).
function assertMissingCatalogFailsBuild(): void {
  for (const [fixture, po, command] of [
    ["next", "intl/no.po", [bin("next"), "build"]],
    ["start", "src/intl/nb.po", [bin("vite"), "build"]],
  ] as const) {
    const path = join(fixtureDir(fixture), po);
    const aside = `${path}.aside`;
    const [file, ...args] = command;
    renameSync(path, aside);
    // Restored before any exit: process.exit skips finally blocks.
    let result: SpawnSyncReturns<string>;
    try {
      result = spawnSync(file, args, { cwd: fixtureDir(fixture), encoding: "utf8" });
    } finally {
      renameSync(aside, path);
    }

    const output = `${result.stdout}${result.stderr}`;

    if (result.status === 0 || !output.includes(basename(po))) {
      process.stderr.write(
        `${fixture}: a build without ${po} did not fail on it (exit ${result.status})\n${output}`
      );
      process.exit(1);
    }

    process.stdout.write(`${fixture}: a build without ${po} fails (exit ${result.status})\n`);
  }
}

// The floor with no bundler (R2-5): a Node script compiles a fixture's PO through the pass's intl-tools and renders it
// through the pass's runtime, both resolved from the fixture.
function assertNodeFloor(runtime: (typeof RUNTIMES)[number]): void {
  const script = [
    'import { loadCatalog } from "@elmeragroup/intl-tools/compile";',
    'import { createIntl } from "@elmeragroup/intl/core";',
    'const loaded = loadCatalog("intl/no.po");',
    'if (loaded._tag !== "Compiled") throw loaded;',
    'console.log(createIntl({ locale: "no", catalog: loaded.catalog, timeZone: "UTC" }).t("Hello from a call"));',
  ].join("\n");
  const rendered = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: fixtureDir("next"),
    encoding: "utf8",
  }).trim();

  if (rendered !== "Hei fra et kall") {
    process.stderr.write(`node floor, ${runtime} packages: rendered ${JSON.stringify(rendered)}\n`);
    process.exit(1);
  }

  process.stdout.write(`node floor, ${runtime} packages: loadCatalog renders "${rendered}"\n`);
}

uninstallPacked();
process.on("exit", uninstallPacked);

for (const runtime of RUNTIMES) {
  if (runtime === "packed") {
    installPacked();
  }

  assertResolution(runtime);
  assertNodeFloor(runtime);
  const env = { INTL_FIXTURE_RUNTIME: runtime, INTL_FIXTURE_SERVER: "prod" };
  // The Next fixture checks through the CLI, as a Next.js host app's build script would; the Start fixture's Vite plugin checks.
  const tools = runtime === "packed" ? `${installed("next", toolsManifest.name)}/` : toolsSource;
  run(process.execPath, [join(tools, toolsManifest.bin["elmera-intl"]), "check"], fixtureDir("next"), env);
  run(bin("next"), ["build"], fixtureDir("next"), env);
  run(bin("vite"), ["build"], fixtureDir("start"), env);
  run(bin("playwright"), ["test", ...process.argv.slice(2)], root, env);

  if (runtime === "linked") {
    // The dev servers, with the dev-loop specs: the same gates as the builds, and a PO save reaching an open tab.
    run(bin("playwright"), ["test", ...process.argv.slice(2)], root, { ...env, INTL_FIXTURE_SERVER: "dev" });
    assertMissingCatalogFailsBuild();
  }
}
