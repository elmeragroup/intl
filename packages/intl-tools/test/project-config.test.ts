import * as Effect from "effect/Effect";
import { resolve } from "node:path";
import { expect, test } from "vitest";

import { loadConfig, parseConfig } from "../src/project-config";
import { decodeConfig, readConfig } from "../src/project-config-read";
import { NodePlatform } from "../src/project-services";
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

// Unit under test: `decodeConfig`, the Schema decode the CLI, Vite and Vitest run. Oracles: `parseConfig`, the hand
// parser `withIntl` runs inside next.config (for each text, the same config or the same first problem, word for word),
// and, for each text, its first diagnostic as a literal, so each message is checked against the field it names. The
// texts reach every problem, each field's ways to be wrong, and the precedence between them: include before exclude,
// both before an escaping glob, which comes before the locales, then the catalogs, then the formats. "not JSON" is
// pinned by its prefix: the JSON parser's own message after it varies by Node version.
const INCLUDE = '"include" must be a non-empty array of glob strings';
const EXCLUDE = '"exclude" must be an array of glob strings';
const LOCALES = '"locales" must be a non-empty array of locale strings';
const CATALOGS = '"catalogs" must be a path pattern with {locale} ending in .po';
const FORMATS = '"formats" must be the path of a .ts or .js module exporting `formats`';
const NOT_OBJECT = "not a JSON object";
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
