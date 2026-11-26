import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createIntl } from "@elmeragroup/intl/core";

import { english } from "./catalogs";

// Unit under test: the bound on what the runtime's default report remembers, with no onError. Oracle: the contract's
// number, 1,000 distinct problems, which bounds the memory a long-lived server keeps for them: past it the record
// clears and a problem may log again. A file of its own, so the record starts empty (Vitest isolates files); each
// problem is a format name `formats` lacks, under the one key `format.number`.
describe("the default report's record", () => {
  it("holds 1,000 problems, then clears for the next one, keeps it, and forgets the rest", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => {
      consoleError.mockRestore();
    });
    const intl = createIntl({ locale: "en", catalog: english(), timeZone: "UTC" });
    const missing = (i: number) => intl.format.number(i, `missing-${String(i)}`);
    const calls = () => consoleError.mock.calls.length;
    const counts: Array<number> = [];

    for (let i = 0; i < 1000; i += 1) {
      missing(i);
    }
    counts.push(calls());
    missing(0);
    counts.push(calls());
    missing(1000);
    counts.push(calls());
    // The pair that cleared the record is the first it then holds, so it does not log again.
    missing(1000);
    counts.push(calls());
    missing(0);
    counts.push(calls());

    expect(counts).toEqual([1000, 1000, 1001, 1001, 1002]);
  });
});
