import { describe, expect, it } from "vitest";

import { catalogEntries, lintConfigFindings, parseJsonc } from "./config-files.ts";

// Unit under test: the manifest test's config readers. Oracle: the JSON and YAML specifications, by hand-written
// inputs whose parsed value is stated in each case.
describe("parseJsonc", () => {
  it("reads a string that ends in an escaped backslash", () => {
    expect(parseJsonc(String.raw`{ "path": "C:\\", "next": 1 }`)).toEqual({ path: "C:\\", next: 1 });
  });

  it("keeps a comma inside a string", () => {
    expect(parseJsonc(`{ "message": ",}" }`)).toEqual({ message: ",}" });
  });

  it("drops comments and trailing commas outside strings", () => {
    expect(parseJsonc(`{\n  // a comment\n  "a": "// not a comment", /* b */\n  "c": [1, 2,],\n}`)).toEqual({
      a: "// not a comment",
      c: [1, 2],
    });
  });
});

describe("catalogEntries", () => {
  it("reads a version with a trailing comment", () => {
    expect(catalogEntries("packages:\n  - packages/*\ncatalog:\n  next: ^16.4.0 # widen\n")).toEqual([
      { name: "next", version: "^16.4.0" },
    ]);
  });

  it("reads named catalogs and quoted names", () => {
    expect(
      catalogEntries(
        `catalog:\n  "@types/node": 26.6.5\ncatalogs:\n  react19:\n    react: 19.3.1\nminimumReleaseAge: 4320\n`
      )
    ).toEqual([
      { name: "@types/node", version: "26.6.5" },
      { name: "react", version: "19.3.1" },
    ]);
  });
});

describe("lintConfigFindings", () => {
  it("passes a config whose exceptions all carry a comment", () => {
    const config = `{
      "categories": { "correctness": "error" },
      "rules": {
        "a": "error",
        // Why b and c are off.
        "b": "off",
        "c": "off",
        "d": ["error", { "x": 1 }]
      },
      "overrides": [
        // Why this file needs it.
        { "files": ["src/one.ts"], "rules": { "e": "off" } },
        { "files": ["**/*.test.ts"], "rules": { "f": "error" } }
      ]
    }`;

    expect(lintConfigFindings(config)).toEqual({ warned: [], unexplainedOffs: [], unexplainedOverrides: [] });
  });

  it("names a warn, an uncommented off, and an uncommented file-scoped override", () => {
    const config = `{
      "categories": { "style": "warn" },
      "rules": { "a": ["warn", "type"], "b": "error", "c": "off" },
      "overrides": [{ "files": ["scripts/release.ts"], "rules": { "no-console": "off" } }]
    }`;

    expect(lintConfigFindings(config)).toEqual({
      warned: ["style", "a"],
      unexplainedOffs: ["c", "no-console"],
      unexplainedOverrides: ["scripts/release.ts"],
    });
  });

  // A comment explains only what follows it in the same container, not a later rule after another one.
  it("does not let a comment explain an off it does not precede", () => {
    const config = `{ "rules": { /* Why a is off. */ "a": "off", "b": "error", "c": "off" } }`;

    expect(lintConfigFindings(config).unexplainedOffs).toEqual(["c"]);
  });
});
