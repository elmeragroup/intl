import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli-run";
import { cliFromSource } from "./cli-source";

const CONFIG = { include: ["src/**/*.{ts,tsx}"], catalogs: "messages/{locale}.po", locales: ["nb"] };
const PAGE = `import { T, Val, useT, msg } from "@elmeragroup/intl/react";
const STATUS = { open: msg("Open", { context: "status" }) };
export function Page({ name }: { name: string }) {
  const t = useT();
  return <p title={t("Order {id}", { id: "1" })}><T>Hello <Val name={name} />, read the <a href="/t">terms</a>.</T>{t.from(STATUS.open)}</p>;
}
`;
const HEADER = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=utf-8\\n"
"Content-Transfer-Encoding: 8bit\\n"
"Language: nb\\n"
"X-Elmera-Serializer: 1\\n"
`;
const TRANSLATIONS: ReadonlyArray<readonly [string, string]> = [
  ["Hello {name}, read the <x0>terms</x0>.", "Hei {name}, les <x0>vilkårene</x0>."],
  ["Open", "Åpen"],
  ["Order {id}", "Ordre {id}"],
];

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "elmera-intl-cli-"));
  write("elmera-intl.json", JSON.stringify(CONFIG));
  write("src/page.tsx", PAGE);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

type CliRun = { readonly code: number; readonly stdout: string; readonly stderr: string };

async function cli(...args: Array<string>): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    cwd: root,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });

  return { code, stdout, stderr };
}

type CheckReport = {
  readonly ok: boolean;
  readonly problems: ReadonlyArray<{
    readonly code: string;
    readonly message: string;
    readonly key?: string;
    readonly fix: string;
  }>;
  readonly unreachable: ReadonlyArray<object>;
};
type CheckRun = { readonly code: number; readonly report: CheckReport };

function readReport(text: string): CheckReport {
  const value: unknown = JSON.parse(text);

  // SAFETY: text is the CLI's --json report, the contract these tests assert; a wrong shape fails the expectations
  // that read it.
  return value as CheckReport;
}

async function check(): Promise<CheckRun> {
  const { code, stdout } = await cli("check", "--json");
  const report = readReport(stdout);

  return { code, report };
}

async function translateAll(): Promise<void> {
  let po = read("messages/nb.po");
  for (const [source, translation] of TRANSLATIONS) {
    po = po.replace(
      `msgid ${JSON.stringify(source)}\nmsgstr ""`,
      `msgid ${JSON.stringify(source)}\nmsgstr ${JSON.stringify(translation)}`
    );
  }
  write("messages/nb.po", po);
  expect((await cli("extract")).code).toBe(0);
}

// Unit under test: the elmera-intl CLI. Oracle: the PO text and problem codes written out per case.
describe("extract", () => {
  it("writes a sorted PO with tag comments and line-free references, and nothing else", async () => {
    const { code, stdout } = await cli("extract");
    expect(code).toBe(0);
    expect(stdout).toBe("3 messages; wrote 1 file(s)\n");
    expect(read("messages/nb.po")).toBe(`${HEADER}
#. <x0> = <a href>
#: src/page.tsx
msgid "Hello {name}, read the <x0>terms</x0>."
msgstr ""

#: src/page.tsx
msgctxt "status"
msgid "Open"
msgstr ""

#: src/page.tsx
msgid "Order {id}"
msgstr ""
`);
    expect(readdirSync(join(root, "messages"))).toEqual(["nb.po"]);
  });

  it("keeps translations, and rewrites nothing on an unchanged rerun", async () => {
    await cli("extract");
    await translateAll();
    const before = read("messages/nb.po");
    // A fixed past mtime: a rewrite of the same bytes still moves it, and watchers key off it.
    const past = new Date("2001-02-03T04:05:06Z");
    utimesSync(join(root, "messages/nb.po"), past, past);
    expect((await cli("extract")).stdout).toBe("3 messages; wrote 0 file(s)\n");
    expect(read("messages/nb.po")).toBe(before);
    expect(statSync(join(root, "messages/nb.po")).mtime).toEqual(past);
  });

  it("drops entries no source uses", async () => {
    await cli("extract");
    write(
      "src/page.tsx",
      `import { useT } from "@elmeragroup/intl/react";\nexport function P() { const t = useT(); return t("Order {id}", { id: "1" }); }\n`
    );
    await cli("extract");
    expect(read("messages/nb.po")).not.toContain("Open");
  });

  it("writes nothing when a source cannot be extracted, and points at it", async () => {
    write(
      "src/bad.tsx",
      `import { useT } from "@elmeragroup/intl/react";\nexport function B(label: string) {\n  const t = useT();\n  return t(label);\n}\n`
    );
    const { code, stderr } = await cli("extract");
    expect(code).toBe(1);
    expect(stderr).toContain("src/bad.tsx:4:9: ExtractFailed: t() takes a string literal");
    expect(() => read("messages/nb.po")).toThrow();
  });

  it("refuses to overwrite a PO it cannot read", async () => {
    await cli("extract");
    write("messages/nb.po", `# translator note\n${read("messages/nb.po")}`);
    const { code, stderr } = await cli("extract");
    expect(code).toBe(1);
    expect(stderr).toContain("CatalogUnreadable");
    expect(read("messages/nb.po")).toContain("# translator note");
  });
});

describe("check", () => {
  it("passes a fully translated, extracted project", async () => {
    await cli("extract");
    await translateAll();
    const { code, report } = await check();
    expect([code, report.ok, report.problems]).toEqual([0, true, []]);
  });

  const codes = async (): Promise<Array<string>> =>
    (await check()).report.problems.map((problem) => problem.code);

  it("reports untranslated messages", async () => {
    await cli("extract");
    expect((await check()).code).toBe(1);
    expect(await codes()).toEqual(["TranslationMissing", "TranslationMissing", "TranslationMissing"]);
  });

  it("reports a catalog missing a new source message, and an obsolete entry", async () => {
    await cli("extract");
    await translateAll();
    write("src/page.tsx", PAGE.replace("Order {id}", "Ordered {id}"));
    expect((await check()).report.problems.map((problem) => [problem.code, problem.key])).toEqual([
      ["CatalogOutOfSync", "Ordered {id}"],
      ["CatalogOutOfSync", "Order {id}"],
    ]);
  });

  // Oracle: a pair found by search (the 36^7 hash space makes one rare, so it is pinned here, not searched for).
  it("reports two messages that share a wire key", async () => {
    write(
      "src/collide.tsx",
      `import { msg } from "@elmeragroup/intl/react";\nexport const A = msg("Order 577786");\nexport const B = msg("Order 634976");\n`
    );
    await cli("extract");
    await translateAll();
    expect((await check()).report.problems.filter(({ code }) => code === "KeyCollision")).toEqual([
      expect.objectContaining({ key: "Order 634976" }),
    ]);
  });

  // The compiled artifact, dry-formatted as the loaders compile it: a currency Intl rejects parses fine and passes
  // every slot check, and would throw only when rendered.
  it("reports a translation that throws when formatted", async () => {
    write(
      "src/price.tsx",
      `import { msg } from "@elmeragroup/intl/react";\nexport const P = msg("{n, number, ::currency/NOK}");\n`
    );
    await cli("extract");
    await translateAll();
    write(
      "messages/nb.po",
      read("messages/nb.po").replace(
        'msgid "{n, number, ::currency/NOK}"\nmsgstr ""',
        'msgid "{n, number, ::currency/NOK}"\nmsgstr "{n, number, ::currency/NOKK}"'
      )
    );
    expect((await check()).report.problems.map(({ code, key }) => [code, key])).toEqual([
      ["TranslationUnformattable", "{n, number, ::currency/NOK}"],
    ]);
  });

  // Oracle: Intl rejects `currency: "NOKK"`; the named style is only invalid through the app's formats module.
  it("dry-formats with the formats module the config names, and reports one that does not load", async () => {
    write(
      "src/price.tsx",
      `import { msg } from "@elmeragroup/intl/react";\nexport const P = msg("{n, number, money}");\n`
    );
    write(
      "intl-formats.ts",
      `export const formats = { number: { money: { style: "currency", currency: "NOKK" } } };\n`
    );
    await cli("extract");
    await translateAll();
    write(
      "messages/nb.po",
      read("messages/nb.po").replace(
        'msgid "{n, number, money}"\nmsgstr ""',
        'msgid "{n, number, money}"\nmsgstr "{n, number, money} kr"'
      )
    );
    expect(await codes()).toEqual([]);

    write("elmera-intl.json", JSON.stringify({ ...CONFIG, formats: "intl-formats.ts" }));
    expect((await check()).report.problems.map(({ code, key }) => [code, key])).toEqual([
      ["TranslationUnformattable", "{n, number, money}"],
      ["SourceUnformattable", "{n, number, money}"],
    ]);

    write("elmera-intl.json", JSON.stringify({ ...CONFIG, formats: "missing.ts" }));
    expect(await codes()).toEqual(["FormatsInvalid"]);
  });

  // Oracle: CLDR's nb and en `one`, which is 1 alone among integers: the exact arms take it, and the search cannot
  // prove that, so check lists the arm as information and passes.
  it("lists an arm no sample reaches, and passes", async () => {
    const source = "{n, plural, =1 {exactly one} =-1 {minus one} one {one} other {#}}";
    write(
      "src/count.tsx",
      `import { msg } from "@elmeragroup/intl/react";\nexport const C = msg(${JSON.stringify(source)});\n`
    );
    await cli("extract");
    await translateAll();
    write(
      "messages/nb.po",
      read("messages/nb.po").replace(
        `msgid ${JSON.stringify(source)}\nmsgstr ""`,
        `msgid ${JSON.stringify(source)}\nmsgstr ${JSON.stringify(source.replace("exactly one", "nøyaktig én"))}`
      )
    );

    const { code, report } = await check();

    expect([code, report.ok, report.problems, report.unreachable]).toEqual([
      0,
      true,
      [],
      [
        { locale: "nb", key: source, arm: "n:one", reason: "not-sampled" },
        { locale: "en", key: source, arm: "n:one", reason: "not-sampled" },
      ],
    ]);
  });

  // Oracle: JSON, which the formats cross to reach the runtime: it turns Infinity and NaN into null (which Intl rejects
  // as out of range) and a Date into a string.
  it.each([
    ["Infinity", "Infinity"],
    ["NaN", "NaN"],
    ["a Date", "new Date(0)"],
  ])("reports a formats option that is not JSON: %s", async (_label, value) => {
    await cli("extract");
    await translateAll();
    write(
      "intl-formats.ts",
      `export const formats = { number: { precise: { maximumFractionDigits: ${value} } } };\n`
    );
    write("elmera-intl.json", JSON.stringify({ ...CONFIG, formats: "intl-formats.ts" }));

    expect((await check()).report.problems.map(({ code, message }) => [code, message])).toEqual([
      ["FormatsInvalid", expect.stringContaining("formats.number.precise.maximumFractionDigits")],
    ]);
  });

  it.each([
    ["a translation that does not compile", "Ordre {id", "TranslationInvalid"],
    ["a renamed placeholder", "Ordre {nr}", "PlaceholderMismatch"],
    // `{id}` takes text: a number format renders NaN for "A-1", a date format throws.
    ["a text placeholder formatted as a number", "Ordre {id, number}", "ArgumentKindMismatch"],
    ["a text placeholder formatted as a date", "Ordre {id, date, short}", "ArgumentKindMismatch"],
    ["a text placeholder used as a plural", "{id, plural, other {Ordre #}}", "ArgumentKindMismatch"],
  ] as const)("reports %s", async (_label, translation, code) => {
    await cli("extract");
    await translateAll();
    write(
      "messages/nb.po",
      read("messages/nb.po").replace('msgstr "Ordre {id}"', `msgstr ${JSON.stringify(translation)}`)
    );
    await cli("extract");
    expect(await codes()).toEqual([code]);
  });

  // The reviewer's mutation: an msgstr left as the English renders English and passed every slot check.
  it("reports a translation identical to its source", async () => {
    await cli("extract");
    await translateAll();
    write("messages/nb.po", read("messages/nb.po").replace('msgstr "Ordre {id}"', 'msgstr "Order {id}"'));
    expect((await check()).report.problems.map(({ code, key }) => [code, key])).toEqual([
      ["TranslationIdenticalToSource", "Order {id}"],
    ]);
  });

  const flagged = '#, ignore-same\nmsgid "Order {id}"';

  it("accepts an identical translation flagged ignore-same, and extract keeps the flag", async () => {
    await cli("extract");
    await translateAll();
    write(
      "messages/nb.po",
      read("messages/nb.po")
        .replace('msgid "Order {id}"', flagged)
        .replace('msgstr "Ordre {id}"', 'msgstr "Order {id}"')
    );
    expect((await cli("extract")).code).toBe(0);
    expect(read("messages/nb.po")).toContain(flagged);
    const { code, report } = await check();
    expect([code, report.problems]).toEqual([0, []]);
  });

  // Oracle: GNU msgcat 1.0, which reads every `#,` line of an entry and writes one, comma-separated, `fuzzy` first.
  it.each([
    ["split, ignore-same first", "#, ignore-same\n#, fuzzy"],
    ["split, fuzzy first", "#, fuzzy\n#, ignore-same"],
    ["one line", "#, ignore-same, fuzzy"],
  ])("keeps every flag when they are %s", async (_label, flagLines) => {
    await cli("extract");
    await translateAll();
    write(
      "messages/nb.po",
      read("messages/nb.po")
        .replace('msgid "Order {id}"', `${flagLines}\nmsgid "Order {id}"`)
        .replace('msgstr "Ordre {id}"', 'msgstr "Order {id}"')
    );
    expect((await check()).report.problems).toEqual([]);
    expect((await cli("extract")).code).toBe(0);
    expect(read("messages/nb.po")).toContain('#, fuzzy, ignore-same\nmsgid "Order {id}"');
    const { code, report } = await check();
    expect([code, report.problems]).toEqual([0, []]);
  });

  // Oracle: GNU msgcat 1.0, run on each input: an entry ends where the next one starts, blank line or not, and an
  // obsolete (`#~`) entry keeps its own comments, comments after the last entry are dropped, and a comment-only block
  // between blank lines goes to the next entry. Extract drops obsolete entries, as it drops every unused one. The
  // first case is the bugs reviewer's input, with the fixture's message for their `Admin`.
  const openEntry = '#: src/page.tsx\nmsgctxt "status"\nmsgid "Open"\nmsgstr "Åpen"\n';
  const orderEntry = '#: src/page.tsx\nmsgid "Order {id}"\nmsgstr "Ordre {id}"\n';
  const fuzzyOrder = '#, fuzzy\nmsgid "Order {id}"\nmsgstr "Order {id}"\n';
  const obsoleteEntry = '#~ msgid "Old"\n#~ msgstr "Old"\n';
  const obsolete = `#, ignore-same\n${obsoleteEntry}`;
  it.each([
    [
      "an obsolete entry runs into the next",
      `${openEntry}\n${obsolete}${fuzzyOrder}`,
      `${openEntry}\n#: src/page.tsx\n${fuzzyOrder}`,
    ],
    [
      "an obsolete entry ends at a blank line",
      `${openEntry}\n${obsolete}\n${fuzzyOrder}`,
      `${openEntry}\n#: src/page.tsx\n${fuzzyOrder}`,
    ],
    [
      "an obsolete entry sits between two entries with no blank line",
      `${openEntry}${obsoleteEntry}${fuzzyOrder}`,
      `${openEntry}\n#: src/page.tsx\n${fuzzyOrder}`,
    ],
    [
      "two entries have no blank line between them",
      `#, ignore-same\nmsgctxt "status"\nmsgid "Open"\nmsgstr "Open"\n${fuzzyOrder}`,
      `#: src/page.tsx\n#, ignore-same\nmsgctxt "status"\nmsgid "Open"\nmsgstr "Open"\n\n#: src/page.tsx\n${fuzzyOrder}`,
    ],
    [
      "an extracted comment follows the last entry",
      `${openEntry}\n${fuzzyOrder}#. trailing note\n`,
      `${openEntry}\n#: src/page.tsx\n${fuzzyOrder}`,
    ],
    [
      "a reference follows the last entry",
      `${openEntry}\n${fuzzyOrder}#: src/old.tsx\n`,
      `${openEntry}\n#: src/page.tsx\n${fuzzyOrder}`,
    ],
    [
      "a flag follows the last entry",
      `${openEntry}\n${fuzzyOrder}#, ignore-same\n`,
      `${openEntry}\n#: src/page.tsx\n${fuzzyOrder}`,
    ],
    [
      "a comment-only block sits between blank lines",
      `${openEntry}\n#, fuzzy\n\nmsgid "Order {id}"\nmsgstr "Order {id}"\n`,
      `${openEntry}\n#: src/page.tsx\n${fuzzyOrder}`,
    ],
  ])("keeps each entry's flags to itself when %s", async (_label, entries, extracted) => {
    await cli("extract");
    await translateAll();
    write("messages/nb.po", read("messages/nb.po").replace(`${openEntry}\n${orderEntry}`, entries));
    const problems = async (): Promise<[number, Array<[string, string | undefined]>]> => {
      const { code, report } = await check();

      return [code, report.problems.map((problem) => [problem.code, problem.key])];
    };
    const identical = [1, [["TranslationIdenticalToSource", "Order {id}"]]];
    expect(await problems()).toEqual(identical);
    expect((await cli("extract")).code).toBe(0);
    expect(read("messages/nb.po").slice(-extracted.length - 2)).toBe(`\n\n${extracted}`);
    expect(await problems()).toEqual(identical);
  });

  it("reports an ignore-same flag on a translation that differs from its source", async () => {
    await cli("extract");
    await translateAll();
    write("messages/nb.po", read("messages/nb.po").replace('msgid "Order {id}"', flagged));
    expect((await check()).report.problems.map(({ code, key }) => [code, key])).toEqual([
      ["IgnoreSameUnused", "Order {id}"],
    ]);
  });

  it("extracts a <Select> inside <T> and checks its translation", async () => {
    write(
      "src/pick.tsx",
      `import { T, Select } from "@elmeragroup/intl/react";\nexport const Pick = ({ kind }: { kind: string }) => <T>Pick <b><Select kind={kind} _a="A" other="O" /></b></T>;\n`
    );
    await cli("extract");
    await translateAll();
    const source = 'msgid "Pick <x0>{kind, select, a {A} other {O}}</x0>"\nmsgstr ""';
    expect(read("messages/nb.po")).toContain(source);
    write(
      "messages/nb.po",
      read("messages/nb.po").replace(
        source,
        source.replace('msgstr ""', 'msgstr "Velg <x0>{kind, select, a {Å} other {Ø}}</x0>"')
      )
    );
    const { code, report } = await check();
    expect([code, report.problems]).toEqual([0, []]);
  });

  it("accepts a text placeholder used as a select", async () => {
    await cli("extract");
    await translateAll();
    write(
      "messages/nb.po",
      read("messages/nb.po").replace('msgstr "Ordre {id}"', 'msgstr "Ordre {id, select, other {{id}}}"')
    );
    await cli("extract");
    expect(await codes()).toEqual([]);
  });

  // A plain `{x}` takes text only, so a number or date shown plainly fails at runtime, and text formatted as a number renders NaN.
  it.each([
    [
      "{n} inside a plural",
      "{n, plural, one {# order} other {# orders}}",
      "{n, plural, one {{n} ordre} other {{n} ordrer}}",
      ["ArgumentKindConflict"],
    ],
    ["a number shown plainly", "{n, number} orders", "{n} ordrer", ["ArgumentKindMismatch"]],
    // The source's plain `{n}` takes text, so the translation may not demand a number.
    ["a plain argument formatted as a number", "{n} orders", "{n, number} ordrer", ["ArgumentKindMismatch"]],
    ["a date shown plainly", "Due {d, date, short}", "Forfall {d}", ["ArgumentKindMismatch"]],
    ["a number formatted as a date", "{n, number} orders", "{n, date} ordrer", ["ArgumentKindMismatch"]],
    // No one value renders in every use: text fails `{n, number}`, a number fails `{n}`.
    [
      "a source using an argument as text and as a number",
      "{state, select, count {{n, number} items} other {Item {n}}}",
      "{state, select, count {{n} varer} other {Vare {n}}}",
      ["ArgumentKindConflict"],
    ],
    [
      "a source using an argument as a number and as a date",
      "{d, number} on {d, date}",
      "{d, number} den {d, date}",
      ["ArgumentKindConflict"],
    ],
    [
      "a translation using a number argument plainly in one branch",
      "{state, select, count {{n, number} items} other {Item {n, number}}}",
      "{state, select, count {{n, number} varer} other {Vare {n}}}",
      ["ArgumentKindConflict"],
    ],
    [
      "{n, number} in every branch",
      "{state, select, count {{n, number} items} other {Item {n, number}}}",
      "{state, select, count {{n, number} varer} other {Vare {n, number}}}",
      [],
    ],
    [
      "# and {n, number} in a plural",
      "{n, plural, one {# item} other {{n, number} items}}",
      "{n, plural, one {# vare} other {{n, number} varer}}",
      [],
    ],
    [
      "a select and a plain use of one argument",
      "{s, select, a {A} other {{s}}}",
      "{s, select, a {Å} other {{s}}}",
      [],
    ],
  ] as const)("judges %s", async (_label, source, translation, expected) => {
    write(
      "src/kinds.tsx",
      `import { msg } from "@elmeragroup/intl/react";\nexport const d = msg(${JSON.stringify(source)});\n`
    );
    await cli("extract");
    await translateAll();
    write(
      "messages/nb.po",
      read("messages/nb.po").replace(
        `msgid ${JSON.stringify(source)}\nmsgstr ""`,
        `msgid ${JSON.stringify(source)}\nmsgstr ${JSON.stringify(translation)}`
      )
    );
    await cli("extract");
    expect(await codes()).toEqual(expected);
  });

  it("reports a dropped tag", async () => {
    await cli("extract");
    await translateAll();
    const po = read("messages/nb.po");
    write("messages/nb.po", po.replace("Hei {name}, les <x0>vilkårene</x0>.", "Hei {name}, les vilkårene."));
    await cli("extract");
    expect(await codes()).toEqual(["TagMismatch"]);
  });

  it("accepts reordered tags", async () => {
    write(
      "src/two.tsx",
      `import { T } from "@elmeragroup/intl/react";\nexport const two = <T>Read <a href="/a">this</a> and <b>that</b></T>;\n`
    );
    await cli("extract");
    await translateAll();
    const source = "Read <x0>this</x0> and <x1>that</x1>";
    const po = read("messages/nb.po");
    write(
      "messages/nb.po",
      po.replace(
        `msgid "${source}"\nmsgstr ""`,
        `msgid "${source}"\nmsgstr "Les <x1>det</x1> og <x0>dette</x0>"`
      )
    );
    await cli("extract");
    expect(await codes()).toEqual([]);
  });

  it("reports a catalog keyed by another serializer version, and extract refuses to rewrite it", async () => {
    await cli("extract");
    await translateAll();
    const stale = read("messages/nb.po").replace("X-Elmera-Serializer: 1", "X-Elmera-Serializer: 0");
    write("messages/nb.po", stale);
    const { report } = await check();
    expect(report.problems.map((problem) => problem.code)).toEqual(["SerializerMismatch"]);
    expect(report.problems[0]?.fix).toContain("move each msgstr to its re-keyed msgid by hand");
    expect((await cli("extract")).code).toBe(1);
    expect(read("messages/nb.po")).toBe(stale);
  });

  it("reports a missing catalog", async () => {
    expect(await codes()).toEqual(["CatalogMissing"]);
  });

  it("reports an include pattern that matches no file, and extract writes nothing", async () => {
    write(
      "elmera-intl.json",
      JSON.stringify({ ...CONFIG, include: [...CONFIG.include, "missing/**/*.tsx"] })
    );
    expect(await codes()).toContain("IncludeUnmatched");
    expect((await cli("extract")).code).toBe(1);
    expect(existsSync(join(root, "messages/nb.po"))).toBe(false);
  });

  it("skips a directory whose name matches an include pattern", async () => {
    await cli("extract");
    await translateAll();
    write("src/odd.tsx/readme.md", "a directory named like a source file");
    const { code, report } = await check();
    expect([code, report.ok]).toEqual([0, true]);
  });

  it("skips a dangling symlink that matches an include pattern", async () => {
    await cli("extract");
    await translateAll();
    symlinkSync(join(root, "src/deleted.tsx"), join(root, "src/dangling.tsx"));
    const { code, report } = await check();
    expect([code, report.ok]).toEqual([0, true]);
  });

  // Oracle: the report tooling parses, written out by hand: two-space indentation, keys in the order ok, problems,
  // messages, written, unreachable, and a trailing newline.
  it("writes only the JSON report to stdout", async () => {
    await cli("extract");
    const untranslated = (key: string) => `    {
      "code": "TranslationMissing",
      "message": "untranslated",
      "fix": "translate it in messages/nb.po, then run \`elmera-intl extract\`",
      "file": "messages/nb.po",
      "locale": "nb",
      "key": ${key}
    }`;
    const { code, stdout, stderr } = await cli("check", "--json");
    expect([code, stderr]).toEqual([1, ""]);
    expect(stdout).toBe(`{
  "ok": false,
  "problems": [
${[untranslated('"Hello {name}, read the <x0>terms</x0>."'), untranslated('"status\\u0004Open"'), untranslated('"Order {id}"')].join(",\n")}
  ],
  "messages": 3,
  "written": [],
  "unreachable": []
}
`);
  });
});

describe("usage", () => {
  // Oracle: the usage text, written out by hand.
  const USAGE = `usage: elmera-intl <extract|check> [--json] [--config <path to elmera-intl.json>]
       elmera-intl extract --watch [--poll <ms>] [--config <path to elmera-intl.json>]
`;

  it.each([
    ["an unknown command", ["translate"], "unknown command: translate"],
    ["no command", [], "unknown command: (none)"],
    ["an unknown flag", ["check", "--unknown", "--json"], "unexpected argument: --unknown"],
    ["--config without a value", ["check", "--config"], "--config needs a path"],
    ["--config followed by a flag", ["check", "--config", "--json"], "--config needs a path"],
    ["a stray argument", ["check", "extra"], "unexpected argument: extra"],
    ["a repeated flag", ["check", "--json", "--json"], "unexpected argument: --json"],
  ])("exits 2 with usage on %s", async (_label, args, reason) => {
    const { code, stdout, stderr } = await cli(...args);
    expect([code, stdout]).toEqual([2, ""]);
    expect(stderr).toBe(`${reason}\n${USAGE}`);
  });

  it("names the fix for a missing config", async () => {
    rmSync(join(root, "elmera-intl.json"));
    const { code, stderr } = await cli("check");
    expect(code).toBe(1);
    expect(stderr).toContain("ConfigInvalid");
    expect(stderr).toContain('fix: write elmera-intl.json as { "include"');
  });

  // The watcher never sees a file outside the root, so extraction must not scan one either.
  it.each([
    ["include", "src/../../shared/**/*.tsx", '"../shared/**/*.tsx"'],
    ["exclude", "/abs/**", '"/abs/**"'],
  ])("rejects an %s pattern reaching outside the project root", async (field, pattern, reported) => {
    write("elmera-intl.json", JSON.stringify({ ...CONFIG, [field]: [pattern] }));
    const { code, stderr } = await cli("check");
    expect(code).toBe(1);
    expect(stderr).toContain(`glob ${reported} reaches outside the project root`);
  });
});

describe("bin", () => {
  it("writes a JSON report larger than a pipe buffer in full", async () => {
    write(
      "src/many.ts",
      `import { msg } from "@elmeragroup/intl/react";\n${Array.from({ length: 1500 }, (_, i) => `msg("Message number ${i} with some padding text");`).join("\n")}\n`
    );
    // Every message untranslated: one problem each.
    expect((await cli("extract")).code).toBe(0);
    const run = spawnSync(execPath, cliFromSource("check", "--json"), {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(run.stdout.length).toBeGreaterThan(65536);
    expect([run.status, readReport(run.stdout).problems.length]).toEqual([1, 1503]);
  });

  it("exits 2 and names the failure when the CLI throws", () => {
    // A file where the catalog directory goes: extract's mkdir throws, an I/O failure the CLI does not classify.
    write("messages", "");
    const run = spawnSync(execPath, cliFromSource("extract"), { cwd: root, encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/^elmera-intl failed: Error:/u);
  });

  it("exits quietly when the reader closes the pipe early", async () => {
    write(
      "src/many.ts",
      `import { msg } from "@elmeragroup/intl/react";\n${Array.from({ length: 1500 }, (_, i) => `msg("Message number ${i} with some padding text");`).join("\n")}\n`
    );
    expect((await cli("extract")).code).toBe(0);
    const child = spawn(execPath, cliFromSource("check", "--json"), { cwd: root });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr += text;
    });
    // `| head -c 60`: take the first chunk, then close the pipe while the report is still being written.
    child.stdout.once("data", () => {
      child.stdout.destroy();
    });
    const code = await new Promise<number | null>((done) => {
      child.on("close", (status) => {
        done(status);
      });
    });
    expect([code, stderr]).toEqual([1, ""]);
  });
});
