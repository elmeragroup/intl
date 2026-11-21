// Builds both fixtures per pass, then runs the Playwright gates on that pass's builds; the linked pass also runs them on
// the dev servers (with the dev-loop specs) and proves a missing PO fails each build. Only ports 3020 (Next) and 3021
// (Start) are the fixtures', so two passes' servers cannot run side by side. The linked pass consumes the
// workspace-linked packages, as the apps do. The packed pass installs `pnpm pack` of packages/intl and
// packages/intl-tools into each fixture as real copies, as npm users get them: bundlers treat an installed package
// differently from a linked one (Vite's SSR externalizes it), and a file missing from either tarball fails there. The
// packed pass also runs the Effect consumer (effect/server.ts) on the packed runtime in a directory of its own.
import type { SpawnSyncReturns } from "node:child_process";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { compileCatalog } from "@elmeragroup/intl-tools/compile";

import toolsManifest from "../../intl-tools/package.json" with { type: "json" };
import runtimeManifest from "../../intl/package.json" with { type: "json" };

const RUNTIMES = ["linked", "packed"] as const;
const FIXTURES = ["next", "start"] as const;
const root = fileURLToPath(new URL("../", import.meta.url));
// Each package, its workspace source, and a module of it every fixture resolves.
const toolsSource = fileURLToPath(new URL("../../intl-tools/", import.meta.url));
const runtimeSource = fileURLToPath(new URL("../../intl/", import.meta.url));
const PACKAGES = [
  { manifest: runtimeManifest, source: runtimeSource, probe: "/react" },
  { manifest: toolsManifest, source: toolsSource, probe: "/vite" },
] as const;
const bin = (name: string) => fileURLToPath(new URL(`../node_modules/.bin/${name}`, import.meta.url));
const fixtureDir = (fixture: string) => `${root}fixtures/${fixture}`;
const installed = (fixture: string, name: string) => `${fixtureDir(fixture)}/node_modules/${name}`;
const effectConsumer = fileURLToPath(new URL("../effect/", import.meta.url));

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

// Link a packed package's third-party dependencies to the workspace's copies; a dependency on the other packed package
// (intl-tools on intl) resolves to that copy, beside it in the fixture's node_modules.
function linkDependencies(
  target: string,
  {
    manifest,
    source,
  }: {
    readonly manifest: { readonly dependencies: Readonly<Record<string, string>> };
    readonly source: string;
  }
): void {
  Object.keys(manifest.dependencies)
    .filter((name) => !PACKAGES.some((other) => other.manifest.name === name))
    .forEach((name) => {
      const link = join(target, "node_modules", name);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(realpathSync(join(source, "node_modules", name)), link);
    });
}

// Each package's `pnpm pack` archive, in `packDir`.
function packAll(
  packDir: string
): ReadonlyArray<{ readonly pkg: (typeof PACKAGES)[number]; readonly tarball: string }> {
  return PACKAGES.map((pkg, index) => {
    const tarball = join(packDir, `${index}.tgz`);
    run("pnpm", ["pack", "--out", tarball], pkg.source, {});

    return { pkg, tarball };
  });
}

// Each tarball's contents as a real directory, its dependencies linked. Peers (react, next, the router, vite) resolve
// through this package as the fixtures' own do.
function installPacked(
  packed: ReadonlyArray<{ readonly pkg: (typeof PACKAGES)[number]; readonly tarball: string }>
): void {
  packed.forEach(({ pkg, tarball }) => {
    FIXTURES.forEach((fixture) => {
      const target = installed(fixture, pkg.manifest.name);
      mkdirSync(target, { recursive: true });
      run("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"], root, {});
      linkDependencies(target, pkg);
    });
  });
}

// The Effect consumer's own directory, as an app that installs the runtime and its optional peer: the packed runtime as
// a real copy with its dependencies linked (without @schummar/icu-type-parser the type-check would accept any ICU
// argument), `effect` linked from the runtime's devDependency (never this package's, which the Next and Start fixtures
// resolve through), the consumer and the catalogs compiled from its nb.po. Outside the workspace, so nothing else
// resolves.
function installEffectConsumer(runtimeTarball: string): string {
  const dir = mkdtempSync(join(tmpdir(), "intl-effect-"));
  const target = join(dir, "node_modules", runtimeManifest.name);
  mkdirSync(target, { recursive: true });
  run("tar", ["-xzf", runtimeTarball, "-C", target, "--strip-components=1"], root, {});
  linkDependencies(target, PACKAGES[0]);
  symlinkSync(
    realpathSync(join(runtimeSource, "node_modules", "effect")),
    join(dir, "node_modules", "effect")
  );
  copyFileSync(join(effectConsumer, "server.ts"), join(dir, "server.ts"));
  copyFileSync(join(effectConsumer, "catalogs.d.ts"), join(dir, "catalogs.d.ts"));
  const po = readFileSync(join(effectConsumer, "nb.po"), "utf8");
  const modules = (["nb", "en"] as const).map((locale) => {
    const compiled = compileCatalog(po, locale);

    if (compiled._tag !== "Compiled") {
      process.stderr.write(`effect consumer: nb.po does not compile for ${locale}\n`);
      process.exit(1);
    }

    return `export const ${locale} = JSON.parse(${JSON.stringify(JSON.stringify(compiled.catalog))});\n`;
  });
  writeFileSync(join(dir, "catalogs.js"), modules.join(""));
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`);
  // The workspace's base options, without the `elmera-source` condition (the command line drops it, as the fixtures'
  // type-check does) and without Node's types, which an Effect app on Web requests does not need.
  writeFileSync(
    join(dir, "tsconfig.json"),
    `${JSON.stringify({
      extends: fileURLToPath(new URL("../../../tooling/typescript/base.json", import.meta.url)),
      compilerOptions: {
        target: "es2022",
        lib: ["ESNext", "DOM"],
        types: [],
        verbatimModuleSyntax: true,
        erasableSyntaxOnly: true,
      },
      include: ["*.ts"],
    })}\n`
  );

  return dir;
}

// The real path of `effect/Effect` as Node resolves it from a directory.
function effectFrom(cwd: string): string {
  const url = execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", 'console.log(import.meta.resolve("effect/Effect"))'],
    { cwd, encoding: "utf8" }
  ).trim();

  return realpathSync(fileURLToPath(url));
}

// The packed `/effect`, as a consumer gets it: one `effect` for the consumer and the package (a second copy would hold
// its own Context), its declarations type-check the consumer, and two overlapping requests get their own locale.
function assertEffectConsumer(dir: string): void {
  const consumerEffect = effectFrom(dir);
  const packageEffect = effectFrom(join(dir, "node_modules", runtimeManifest.name, "dist"));

  if (consumerEffect !== packageEffect) {
    process.stderr.write(
      `effect consumer: effect resolves to ${consumerEffect} and, from the package, ${packageEffect}\n`
    );
    process.exit(1);
  }

  run(bin("tsrs"), ["--noEmit", "-p", dir, "--customConditions", "null"], root, {});
  const answered = execFileSync(process.execPath, ["server.ts"], { cwd: dir, encoding: "utf8" }).trim();

  if (answered !== JSON.stringify(["Hei, Ada", "Hello, Ada"])) {
    process.stderr.write(`effect consumer: the nb and en requests answered ${answered}\n`);
    process.exit(1);
  }

  process.stdout.write(`effect consumer, packed runtime: nb and en requests answer ${answered}\n`);
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
    const packDir = mkdtempSync(join(tmpdir(), "intl-pack-"));
    const packed = packAll(packDir);
    installPacked(packed);
    const runtimeTarball = packed.find(({ pkg }) => pkg.manifest.name === runtimeManifest.name)?.tarball;

    if (runtimeTarball === undefined) {
      process.stderr.write("the runtime was not packed\n");
      process.exit(1);
    }

    const consumer = installEffectConsumer(runtimeTarball);
    rmSync(packDir, { recursive: true, force: true });
    process.on("exit", () => rmSync(consumer, { recursive: true, force: true }));
    assertEffectConsumer(consumer);
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
