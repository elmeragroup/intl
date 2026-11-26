import { describe, expect, it } from "vitest";

import { parsePort } from "../src/lib/port";

// Unit under test: parsePort, the one reading of PORT that both `pnpm start` and the og:image fallback origin take.
// Oracle: the rule the module states, written out per input: unset or empty is 3033, the port `pnpm start` serves on;
// a TCP port (1 to 65535, decimal digits) is itself; anything else, port 0 included, is refused.
describe("parsePort", () => {
  it.each([
    [undefined, 3033],
    ["", 3033],
    ["1", 1],
    ["3042", 3042],
    ["65535", 65_535],
  ])("takes %o as %i", (input, port) => {
    expect(parsePort(input)).toEqual({ _tag: "ok", value: port });
  });

  it.each(["0", "65536", "eighty", "-1", "3.5", " 3042", "0x10", "1e3", "123456"])("refuses %o", (input) => {
    const result = parsePort(input);

    expect(result._tag === "err" ? [result.error._tag, result.error.input] : result.value).toEqual([
      "InvalidPort",
      input,
    ]);
  });
});
