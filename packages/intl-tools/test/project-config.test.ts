import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

import { loadConfig, parseConfig } from "../src/project-config";
import { decodeConfig, readConfig, readConfigSnapshot } from "../src/project-config-read";
import { NodePlatform } from "../src/project-services";
import type { Project } from "./project-fixture";
import { openProject } from "./project-fixture";

// Each test owns its project (see `Project`).
const it = test.extend("project", ({ task }, { onCleanup }) => {
  const { project, close } = openProject("elmera-intl-config-", task.timeout);
  onCleanup(close);

  return project;
});

// Unit under test: the config read and parse. Oracle: a problem names the config path exactly as the caller supplied
// it (here with a `./` segment no resolution keeps), while the config's root is that file's absolute directory.
it("names the supplied path verbatim in a problem, and roots the config at its directory", ({ project }) => {
  const { root } = project;
  project.write("bad.json", "{ not json");
  project.write(
    "elmera-intl.json",
    JSON.stringify({
      include: ["src/**"],
      catalogs: "messages/{locale}.po",
      locales: ["nb"],
      formats: "f.ts",
    })
  );

  const invalid = loadConfig(`${root}/./bad.json`);
  const valid = loadConfig(`${root}/./elmera-intl.json`);

  expect(invalid._tag === "ConfigInvalid" ? invalid.problem.file : invalid._tag).toBe(`${root}/./bad.json`);
  expect(valid._tag === "Config" ? [valid.config.root, valid.config.formats] : valid._tag).toEqual([
    root,
    project.path("f.ts"),
  ]);
});

// Unit under test: the config read the CLI, Vite and Vitest run (`readConfig`, through Node's `FileSystem`). Oracle:
// `loadConfig`, the synchronous read `withIntl` runs inside next.config: both decode the file as `readFileSync(path,
// "utf8")` does, a byte order mark kept, so a config that starts with one is the same "not JSON" problem in every
// host, never a config the CLI accepts and next.config rejects.
it("reads a config that starts with a byte order mark as withIntl reads it", async ({ project }) => {
  project.write(
    "elmera-intl.json",
    `﻿${JSON.stringify({ include: ["src/**"], catalogs: "messages/{locale}.po", locales: ["nb"] })}`
  );
  const path = project.path("elmera-intl.json");

  const read = await Effect.runPromise(readConfig(path).pipe(Effect.provide(NodePlatform)));

  expect(read).toEqual(loadConfig(path));
  expect(read._tag).toBe("ConfigInvalid");
});

// Unit under test: the watch's read of the config (`readConfigSnapshot`), one read with no existence check before it.
// Oracle: `readConfig`, the one-shot commands' read, which asks Node's existsSync first: for every way a path fails
// to be read, the same config or the same problem, word for word ("not found" for what existsSync calls missing,
// "not JSON" with the read's error otherwise).
it.for([
  { path: "missing.json", setup: () => undefined },
  { path: "a-directory", setup: (project: Project) => mkdirSync(project.path("a-directory")) },
  {
    path: "dangling.json",
    setup: (project: Project) => symlinkSync(project.path("gone.json"), project.path("dangling.json")),
  },
  {
    path: "loop.json",
    setup: (project: Project) => symlinkSync(project.path("loop.json"), project.path("loop.json")),
  },
  { path: "file/elmera-intl.json", setup: (project: Project) => project.write("file", "") },
  { path: "locked/elmera-intl.json", setup: (project: Project) => project.lock("locked") },
  {
    path: "unreadable.json",
    setup: (project: Project) => {
      project.write("unreadable.json", "{}");
      chmodSync(project.path("unreadable.json"), 0o000);
    },
  },
  {
    path: "elmera-intl.json",
    setup: (project: Project) => project.write("elmera-intl.json", '{ "include": ["src/**"] }'),
  },
])("reads $path in the watch as the commands read it", async ({ path, setup }, { project }) => {
  setup(project);
  const config = project.path(path);

  const reread = await Effect.runPromise(readConfigSnapshot(config).pipe(Effect.provide(NodePlatform)));

  expect(reread.loaded).toEqual(
    await Effect.runPromise(readConfig(config).pipe(Effect.provide(NodePlatform)))
  );
});

// Unit under test: the watch's read of the config (`readConfigSnapshot`), on a file system whose `access` succeeds on a
// dangling link, as Windows' can, where Node's existsSync then stats the path too (node src/node_file.cc, v26.13.0,
// lines 1099-1109). Oracle: `readConfig` on Node, whose existsSync calls a dangling link missing: "not found".
it("reads a dangling link in the watch as not found where access reaches the link itself", async ({
  project,
}) => {
  symlinkSync(project.path("gone.json"), project.path("dangling.json"));
  const config = project.path("dangling.json");
  const linkAccess = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const live = yield* FileSystem.FileSystem;

      return {
        ...live,
        access: Effect.fn("linkAccess")(function* (
          path: string,
          options?: Parameters<typeof live.access>[1]
        ) {
          if (path !== config) {
            yield* live.access(path, options);
          }
        }),
      };
    })
  );

  const reread = await Effect.runPromise(
    readConfigSnapshot(config).pipe(Effect.provide(Layer.provideMerge(linkAccess, NodePlatform)))
  );

  expect(reread.loaded).toEqual(
    await Effect.runPromise(readConfig(config).pipe(Effect.provide(NodePlatform)))
  );
});

// Unit under test: `decodeConfig`, the Schema decode the CLI, Vite and Vitest run. Oracles: `parseConfig`, the hand
// parser `withIntl` runs inside next.config (for each text, the same config or the same first problem, word for word),
// and, for each text, its first diagnostic as a literal, so each message is checked against the field it names. The
// texts reach every problem, each field's ways to be wrong, and the precedence between them: include before exclude,
// both before an escaping glob, which comes before the locales, then the catalogs, then the formats, and last whether
// two locales' catalog paths could name one file. "not JSON" is pinned by its prefix: the JSON parser's own message
// after it varies by Node version.
const INCLUDE = '"include" must be a non-empty array of glob strings';
const EXCLUDE = '"exclude" must be an array of glob strings';
const LOCALES = '"locales" must be a non-empty array of locale strings';
const CATALOGS = '"catalogs" must be a path pattern with {locale} ending in .po';
const FORMATS = '"formats" must be the path of a .ts or .js module exporting `formats`';
const NOT_OBJECT = "not a JSON object";
const CLIMBING =
  '"catalogs" must not hold a ".." segment anywhere after the first segment holding {locale} (a directory the sync creates could make two locales\' paths name one catalog)';
const notTag = (locale: string) =>
  `locale ${JSON.stringify(locale)} is not a locale identifier Intl.getCanonicalLocales accepts (such as "nb" or "pt-BR"): it names the locale's catalog and how its messages format`;
const oneTag = (first: string, second: string, tag: string) =>
  `locales ${JSON.stringify(first)} and ${JSON.stringify(second)} are one locale identifier, ${tag}: each locale needs a catalog of its own`;
const shared = (pattern: string, locales: ReadonlyArray<string>) =>
  JSON.stringify({ include: ["src/**"], catalogs: pattern, locales });
const CONFIG_TEXTS: ReadonlyArray<readonly [text: string, first: string]> = [
  [
    '{ "include": ["./src/**/*.tsx"], "exclude": ["./src/skip/**"], "catalogs": "messages/{locale}.po", "locales": ["nb", "sv"], "formats": "./src/formats.ts", "extra": 1 }',
    "valid",
  ],
  [
    '{ "include": ["src/**"], "catalogs": "/abs/{locale}.po", "locales": ["nb"], "formats": "/abs/formats.mjs" }',
    "valid",
  ],
  ["{ not json", "not JSON"],
  ["\uFEFF{}", "not JSON"],
  ["5", NOT_OBJECT],
  ["null", NOT_OBJECT],
  ['"text"', NOT_OBJECT],
  ["[]", INCLUDE],
  ['["src/**"]', INCLUDE],
  ["{}", INCLUDE],
  ['{ "include": [] }', INCLUDE],
  ['{ "include": "src/**" }', INCLUDE],
  ['{ "include": ["src/**", 1] }', INCLUDE],
  ['{ "include": ["../a"], "exclude": 5 }', EXCLUDE],
  ['{ "include": [], "exclude": 5 }', INCLUDE],
  ['{ "include": ["src/**"], "exclude": 5 }', EXCLUDE],
  ['{ "include": ["src/**"], "exclude": null }', EXCLUDE],
  ['{ "include": ["src/**"], "exclude": ["/abs/**"] }', 'glob "/abs/**" reaches outside the project root'],
  ['{ "include": ["./../x"] }', 'glob "../x" reaches outside the project root'],
  ['{ "include": ["../a"], "locales": [] }', 'glob "../a" reaches outside the project root'],
  ['{ "include": ["src/**"] }', LOCALES],
  ['{ "include": ["src/**"], "locales": [] }', LOCALES],
  ['{ "include": ["src/**"], "locales": ["nb", 2] }', LOCALES],
  ['{ "include": ["src/**"], "locales": ["nb"] }', CATALOGS],
  ['{ "include": ["src/**"], "locales": ["nb"], "catalogs": "messages/nb.po" }', CATALOGS],
  ['{ "include": ["src/**"], "locales": ["nb"], "catalogs": "messages/{locale}.json" }', CATALOGS],
  ['{ "include": ["src/**"], "locales": ["nb"], "catalogs": 5 }', CATALOGS],
  ['{ "include": ["src/**"], "locales": ["nb"], "catalogs": 5, "formats": 1 }', CATALOGS],
  ['{ "include": ["src/**"], "locales": ["nb"], "catalogs": "{locale}.po", "formats": null }', FORMATS],
  [
    '{ "include": ["src/**"], "locales": ["nb"], "catalogs": "{locale}.po", "formats": "formats.json" }',
    FORMATS,
  ],
  ['{ "include": ["src/**"], "locales": [], "catalogs": 5, "formats": 1 }', LOCALES],
  // Catalog paths two locales could share (#18). These configs once reached the watch and extract, whose tests showed
  // the sync coping with them: a relative `{locale}/..` pattern and a duplicate locale read one file once per sync and
  // kept a save made after that read; locales that one pattern or a case-insensitive file system folds into one file
  // wrote it in turn, ending with the last locale's catalog; and an absolute `{locale}/..` pattern through a locale
  // directory the sync creates kept the translation with locales ["nb", "sv"], and lost it with ["sv", "nb"]. No host
  // takes them now. A `..` before `{locale}` is the same for every locale and stays valid (watch-saves.test.ts writes
  // through `messages/jump/../{locale}.po` with `jump` a linked directory).
  [shared("messages/{locale}/../catalog.po", ["nb", "sv"]), CLIMBING],
  [shared("/abs/messages/{locale}/../catalog.po", ["sv", "nb"]), CLIMBING],
  [shared("messages\\{locale}\\..\\catalog.po", ["nb", "sv"]), CLIMBING],
  [shared("{locale}/sub/../catalog.po", ["nb"]), CLIMBING],
  [shared("/abs/messages/jump/../{locale}.po", ["nb", "sv"]), "valid"],
  [shared("messages/{locale}/x..po", ["nb", "pt-BR", "zh-Hant-TW", "en-us"]), "valid"],
  // A locale is an identifier Intl.getCanonicalLocales accepts, never a path (nor every BCP 47 tag: en-GB-oed): "/nb", "../messages/nb" and, under the
  // root, an absolute "<root>/nb" each name nb's catalog through another string, and a save between the two reads of
  // that one file was lost for a moment. Two spellings of one tag ("NB", "iw" for "he") are one locale.
  [shared("{locale}.po", ["nb", "/nb"]), notTag("/nb")],
  [shared("messages/{locale}.po", ["nb", "../messages/nb"]), notTag("../messages/nb")],
  [shared("{locale}.po", ["nb", "/app/nb"]), notTag("/app/nb")],
  [shared("messages/{locale}.po", ["nb", "x/../sv"]), notTag("x/../sv")],
  [shared("messages/{locale}.po", ["nb_NO"]), notTag("nb_NO")],
  [shared("messages/{locale}.po", ["en-GB-oed"]), notTag("en-GB-oed")],
  [shared("messages/{locale}.po", [""]), notTag("")],
  [
    shared("messages/{locale}.po", ["nb", "sv", "nb"]),
    'locale "nb" is listed twice: each locale needs a catalog of its own',
  ],
  [shared("messages/{locale}.po", ["nb", "NB"]), oneTag("nb", "NB", "nb")],
  [shared("messages/{locale}.po", ["he", "iw"]), oneTag("he", "iw", "he")],
  [shared("messages/{locale}.po", ["en-US", "en-us"]), oneTag("en-US", "en-us", "en-US")],
  ['{ "include": ["src/**"], "locales": ["nb", "nb"], "catalogs": 5 }', CATALOGS],
  [
    '{ "include": ["src/**"], "locales": ["nb", "nb"], "catalogs": "{locale}/../x.po", "formats": 1 }',
    FORMATS,
  ],
];

it("decodes every config as the hand parser withIntl runs parses it, each first diagnostic as pinned", ({
  project,
}) => {
  const path = `${project.root}/./elmera-intl.json`;
  const first = (loaded: ReturnType<typeof parseConfig>) =>
    loaded._tag === "Config" ? "valid" : loaded.problem.message.replace(/^not JSON: .*/u, "not JSON");

  const decoded = CONFIG_TEXTS.map(([text]) => decodeConfig(text, path, project.root, { resolve }));

  expect(decoded).toEqual(CONFIG_TEXTS.map(([text]) => parseConfig(text, path, project.root)));
  expect(decoded.map((loaded) => first(loaded))).toEqual(CONFIG_TEXTS.map(([, pinned]) => pinned));
});
