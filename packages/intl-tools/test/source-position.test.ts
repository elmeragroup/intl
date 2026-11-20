import { describe, expect, it } from "vitest";

import { createSourceMapper } from "../src/source-position";

// Unit under test: createSourceMapper. Oracle: the source map v3 spec, decoded by hand ("AAAA" maps generated 1:0 to
// source 1:0; "K" is a 1-field segment at generated column 5 that maps to no source).
describe("createSourceMapper", () => {
  it("maps a position after a generated-only segment to no source position", () => {
    expect(createSourceMapper("AAAA,K")({ line: 1, column: 6 })).toBeUndefined();
  });
});
