import { expect, test } from "vitest";

import { loadConfig } from "../src/project-config";
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
