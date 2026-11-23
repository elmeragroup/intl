import * as Effect from "effect/Effect";
import { expect, test } from "vitest";

import { FIELD_PROBLEMS, loadConfig, parseConfig } from "../src/project-config";
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

// Unit under test: `decodeConfig`, the Schema decode the CLI, Vite and Vitest run. Oracle: `parseConfig`, the hand
// parser `withIntl` runs inside next.config: for each text, the same config or the same first problem, word for word.
// The texts reach every problem, each field's ways to be wrong, and the order between them (an escaping glob beside an
// invalid exclude or invalid locales), so the two cannot drift apart unseen.
const CONFIG_TEXTS: ReadonlyArray<string> = [
  '{ "include": ["./src/**/*.tsx"], "exclude": ["./src/skip/**"], "catalogs": "messages/{locale}.po", "locales": ["nb", "sv"], "formats": "./src/formats.ts", "extra": 1 }',
  '{ "include": ["src/**"], "catalogs": "/abs/{locale}.po", "locales": ["nb"], "formats": "/abs/formats.mjs" }',
  "{ not json",
  "﻿{}",
  "5",
  "null",
  '"text"',
  "[]",
  '["src/**"]',
  "{}",
  '{ "include": [] }',
  '{ "include": "src/**" }',
  '{ "include": ["src/**", 1] }',
  '{ "include": ["../a"], "exclude": 5 }',
  '{ "include": ["src/**"], "exclude": null }',
  '{ "include": ["src/**"], "exclude": ["/abs/**"] }',
  '{ "include": ["./../x"] }',
  '{ "include": ["../a"], "locales": [] }',
  '{ "include": ["src/**"] }',
  '{ "include": ["src/**"], "locales": [] }',
  '{ "include": ["src/**"], "locales": ["nb", 2] }',
  '{ "include": ["src/**"], "locales": ["nb"] }',
  '{ "include": ["src/**"], "locales": ["nb"], "catalogs": "messages/nb.po" }',
  '{ "include": ["src/**"], "locales": ["nb"], "catalogs": "messages/{locale}.json" }',
  '{ "include": ["src/**"], "locales": ["nb"], "catalogs": 5 }',
  '{ "include": ["src/**"], "locales": ["nb"], "catalogs": "{locale}.po", "formats": null }',
  '{ "include": ["src/**"], "locales": ["nb"], "catalogs": "{locale}.po", "formats": "formats.json" }',
  '{ "include": ["src/**"], "locales": [], "catalogs": 5, "formats": 1 }',
];

it("decodes every config as the hand parser withIntl runs parses it", ({ project }) => {
  const path = `${project.root}/./elmera-intl.json`;
  const outcome = (loaded: ReturnType<typeof parseConfig>) =>
    loaded._tag === "Config" ? "valid" : loaded.problem.message.replace(/^(not JSON|glob)[: ].*/u, "$1");

  const decoded = CONFIG_TEXTS.map((text) => decodeConfig(text, path, project.root));

  expect(decoded).toEqual(CONFIG_TEXTS.map((text) => parseConfig(text, path, project.root)));
  expect(new Set(decoded.map((loaded) => outcome(loaded)))).toEqual(
    new Set(["valid", "not JSON", "not a JSON object", "glob", ...Object.values(FIELD_PROBLEMS)])
  );
});
