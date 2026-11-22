import * as Cause from "effect/Cause";
import * as CliConfig from "effect/cli/CliConfig";
import * as CliOutput from "effect/cli/CliOutput";
import * as Flag from "effect/cli/Flag";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { CliPlatform, cliProgram, exitCodeOf } from "../src/cli-run";
import { Reporter } from "../src/reporter";
import { CatalogSync, FileEvents } from "../src/watch";
import type { Project } from "./project-fixture";
import { openProject } from "./project-fixture";

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

// Each test owns its project (see `Project`): every helper below takes it, and no test reads a shared root after an
// await, so one that overruns cannot touch the next test's files. Every wait ends by the project's deadline.
const it = test.extend("project", ({ task }, { onCleanup }) => {
  const { project, close } = openProject("elmera-intl-cli-", task.timeout);
  onCleanup(close);
  project.write("elmera-intl.json", JSON.stringify(CONFIG));
  project.write("src/page.tsx", PAGE);

  return project;
});

type CliRun = { readonly code: number; readonly stdout: string; readonly stderr: string };

// The built `elmera-intl` executable, spawned as a user's shell runs it: its bytes on stdout and stderr and its exit
// code are the CLI's contract, whatever runs behind them.
const BIN = fileURLToPath(new URL("../bin/elmera-intl.js", import.meta.url));

// The timeout of a test that spawns the executable. Every spawn's hang guard is the project's deadline (a CLI that
// starts watching never exits on its own, and one that outlives a signal is still blocked), so the guard decides and
// the test fails before its timeout.
const BIN_TEST = { timeout: 20_000 };

function bin(project: Project, ...args: Array<string>): CliRun {
  const run = spawnSync(execPath, [BIN, ...args], {
    cwd: project.root,
    encoding: "utf8",
    ...project.spawnGuard(),
  });

  return { code: run.status ?? Number.NaN, stdout: run.stdout, stderr: run.stderr };
}

// `cliProgram` in-process, under `settings` (a host's own effect/cli settings, as a host runtime that provides Node's
// services may), its exit read as the executable reads it. A crash rejects with the thrown Error, so a test fails on
// the crash itself, not on what a later step finds missing; the bin tests own a crash's exit 2.
async function inProcess<ROut>(
  project: Project,
  args: ReadonlyArray<string>,
  settings: Layer.Layer<ROut>
): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const io = Reporter.layer({
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  const exit = await project.within(
    Effect.runPromiseExit(
      cliProgram(args, { cwd: project.root }).pipe(
        Effect.provide([CliPlatform, settings, io, CatalogSync.layer(), FileEvents.layer()])
      )
    ),
    `elmera-intl ${args.join(" ")}`
  );

  if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) {
    throw Cause.squash(exit.cause);
  }

  return { code: exitCodeOf(exit), stdout, stderr };
}

async function cli(project: Project, ...args: Array<string>): Promise<CliRun> {
  return inProcess(project, args, Layer.empty);
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

async function check(project: Project): Promise<CheckRun> {
  const { code, stdout } = await cli(project, "check", "--json");
  const report = readReport(stdout);

  return { code, report };
}

async function translateAll(project: Project): Promise<void> {
  let po = project.read("messages/nb.po");
  for (const [source, translation] of TRANSLATIONS) {
    po = po.replace(
      `msgid ${JSON.stringify(source)}\nmsgstr ""`,
      `msgid ${JSON.stringify(source)}\nmsgstr ${JSON.stringify(translation)}`
    );
  }
  project.write("messages/nb.po", po);
  expect((await cli(project, "extract")).code).toBe(0);
}

// Unit under test: the elmera-intl CLI. Oracle: the PO text and problem codes written out per case.
describe("extract", () => {
  it("writes a sorted PO with tag comments and line-free references, and nothing else", async ({
    project,
  }) => {
    const { code, stdout } = await cli(project, "extract");
    expect(code).toBe(0);
    expect(stdout).toBe("3 messages; wrote 1 file(s)\n");
    expect(project.read("messages/nb.po")).toBe(`${HEADER}
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
    expect(readdirSync(project.path("messages"))).toEqual(["nb.po"]);
  });

  it("keeps translations, and rewrites nothing on an unchanged rerun", async ({ project }) => {
    await cli(project, "extract");
    await translateAll(project);
    const before = project.read("messages/nb.po");
    // A fixed past mtime: a rewrite of the same bytes still moves it, and watchers key off it.
    const past = new Date("2001-02-03T04:05:06Z");
    utimesSync(project.path("messages/nb.po"), past, past);
    expect((await cli(project, "extract")).stdout).toBe("3 messages; wrote 0 file(s)\n");
    expect(project.read("messages/nb.po")).toBe(before);
    expect(statSync(project.path("messages/nb.po")).mtime).toEqual(past);
  });

  it("drops entries no source uses", async ({ project }) => {
    await cli(project, "extract");
    project.write(
      "src/page.tsx",
      `import { useT } from "@elmeragroup/intl/react";\nexport function P() { const t = useT(); return t("Order {id}", { id: "1" }); }\n`
    );
    await cli(project, "extract");
    expect(project.read("messages/nb.po")).not.toContain("Open");
  });

  it("writes nothing when a source cannot be extracted, and points at it", async ({ project }) => {
    project.write(
      "src/bad.tsx",
      `import { useT } from "@elmeragroup/intl/react";\nexport function B(label: string) {\n  const t = useT();\n  return t(label);\n}\n`
    );
    const { code, stderr } = await cli(project, "extract");
    expect(code).toBe(1);
    expect(stderr).toContain("src/bad.tsx:4:9: ExtractFailed: t() takes a string literal");
    expect(() => project.read("messages/nb.po")).toThrow();
  });

  it("refuses to overwrite a PO it cannot read", async ({ project }) => {
    await cli(project, "extract");
    project.write("messages/nb.po", `# translator note\n${project.read("messages/nb.po")}`);
    const { code, stderr } = await cli(project, "extract");
    expect(code).toBe(1);
    expect(stderr).toContain("CatalogUnreadable");
    expect(project.read("messages/nb.po")).toContain("# translator note");
  });
});

describe("check", () => {
  it("passes a fully translated, extracted project", async ({ project }) => {
    await cli(project, "extract");
    await translateAll(project);
    const { code, report } = await check(project);
    expect([code, report.ok, report.problems]).toEqual([0, true, []]);
  });

  const codes = async (project: Project): Promise<Array<string>> =>
    (await check(project)).report.problems.map((problem) => problem.code);

  it("reports untranslated messages", async ({ project }) => {
    await cli(project, "extract");
    expect((await check(project)).code).toBe(1);
    expect(await codes(project)).toEqual(["TranslationMissing", "TranslationMissing", "TranslationMissing"]);
  });

  it("reports a catalog missing a new source message, and an obsolete entry", async ({ project }) => {
    await cli(project, "extract");
    await translateAll(project);
    project.write("src/page.tsx", PAGE.replace("Order {id}", "Ordered {id}"));
    expect((await check(project)).report.problems.map((problem) => [problem.code, problem.key])).toEqual([
      ["CatalogOutOfSync", "Ordered {id}"],
      ["CatalogOutOfSync", "Order {id}"],
    ]);
  });

  // Oracle: a pair found by search (the 36^7 hash space makes one rare, so it is pinned here, not searched for).
  it("reports two messages that share a wire key", async ({ project }) => {
    project.write(
      "src/collide.tsx",
      `import { msg } from "@elmeragroup/intl/react";\nexport const A = msg("Order 577786");\nexport const B = msg("Order 634976");\n`
    );
    await cli(project, "extract");
    await translateAll(project);
    expect((await check(project)).report.problems.filter(({ code }) => code === "KeyCollision")).toEqual([
      expect.objectContaining({ key: "Order 634976" }),
    ]);
  });

  // The compiled artifact, dry-formatted as the loaders compile it: a currency Intl rejects parses fine and passes
  // every slot check, and would throw only when rendered.
  it("reports a translation that throws when formatted", async ({ project }) => {
    project.write(
      "src/price.tsx",
      `import { msg } from "@elmeragroup/intl/react";\nexport const P = msg("{n, number, ::currency/NOK}");\n`
    );
    await cli(project, "extract");
    await translateAll(project);
    project.write(
      "messages/nb.po",
      project
        .read("messages/nb.po")
        .replace(
          'msgid "{n, number, ::currency/NOK}"\nmsgstr ""',
          'msgid "{n, number, ::currency/NOK}"\nmsgstr "{n, number, ::currency/NOKK}"'
        )
    );
    expect((await check(project)).report.problems.map(({ code, key }) => [code, key])).toEqual([
      ["TranslationUnformattable", "{n, number, ::currency/NOK}"],
    ]);
  });

  // Oracle: Intl rejects `currency: "NOKK"`; the named style is only invalid through the app's formats module.
  it("dry-formats with the formats module the config names, and reports one that does not load", async ({
    project,
  }) => {
    project.write(
      "src/price.tsx",
      `import { msg } from "@elmeragroup/intl/react";\nexport const P = msg("{n, number, money}");\n`
    );
    project.write(
      "intl-formats.ts",
      `export const formats = { number: { money: { style: "currency", currency: "NOKK" } } };\n`
    );
    await cli(project, "extract");
    await translateAll(project);
    project.write(
      "messages/nb.po",
      project
        .read("messages/nb.po")
        .replace(
          'msgid "{n, number, money}"\nmsgstr ""',
          'msgid "{n, number, money}"\nmsgstr "{n, number, money} kr"'
        )
    );
    expect(await codes(project)).toEqual([]);

    project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, formats: "intl-formats.ts" }));
    expect((await check(project)).report.problems.map(({ code, key }) => [code, key])).toEqual([
      ["TranslationUnformattable", "{n, number, money}"],
      ["SourceUnformattable", "{n, number, money}"],
    ]);

    project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, formats: "missing.ts" }));
    expect(await codes(project)).toEqual(["FormatsInvalid"]);
  });

  // Oracle: CLDR's nb and en `one`, which is 1 alone among integers: the exact arms take it, and the search cannot
  // prove that, so check lists the arm as information and passes.
  it("lists an arm no sample reaches, and passes", async ({ project }) => {
    const source = "{n, plural, =1 {exactly one} =-1 {minus one} one {one} other {#}}";
    project.write(
      "src/count.tsx",
      `import { msg } from "@elmeragroup/intl/react";\nexport const C = msg(${JSON.stringify(source)});\n`
    );
    await cli(project, "extract");
    await translateAll(project);
    project.write(
      "messages/nb.po",
      project
        .read("messages/nb.po")
        .replace(
          `msgid ${JSON.stringify(source)}\nmsgstr ""`,
          `msgid ${JSON.stringify(source)}\nmsgstr ${JSON.stringify(source.replace("exactly one", "nøyaktig én"))}`
        )
    );

    const { code, report } = await check(project);

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
  it.for([
    ["Infinity", "Infinity"],
    ["NaN", "NaN"],
    ["a Date", "new Date(0)"],
  ])("reports a formats option that is not JSON: %s", async ([_label, value], { project }) => {
    await cli(project, "extract");
    await translateAll(project);
    project.write(
      "intl-formats.ts",
      `export const formats = { number: { precise: { maximumFractionDigits: ${value} } } };\n`
    );
    project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, formats: "intl-formats.ts" }));

    expect((await check(project)).report.problems.map(({ code, message }) => [code, message])).toEqual([
      ["FormatsInvalid", expect.stringContaining("formats.number.precise.maximumFractionDigits")],
    ]);
  });

  it.for([
    ["a translation that does not compile", "Ordre {id", "TranslationInvalid"],
    ["a renamed placeholder", "Ordre {nr}", "PlaceholderMismatch"],
    // `{id}` takes text: a number format renders NaN for "A-1", a date format throws.
    ["a text placeholder formatted as a number", "Ordre {id, number}", "ArgumentKindMismatch"],
    ["a text placeholder formatted as a date", "Ordre {id, date, short}", "ArgumentKindMismatch"],
    ["a text placeholder used as a plural", "{id, plural, other {Ordre #}}", "ArgumentKindMismatch"],
  ] as const)("reports %s", async ([_label, translation, code], { project }) => {
    await cli(project, "extract");
    await translateAll(project);
    project.write(
      "messages/nb.po",
      project.read("messages/nb.po").replace('msgstr "Ordre {id}"', `msgstr ${JSON.stringify(translation)}`)
    );
    await cli(project, "extract");
    expect(await codes(project)).toEqual([code]);
  });

  // The reviewer's mutation: an msgstr left as the English renders English and passed every slot check.
  it("reports a translation identical to its source", async ({ project }) => {
    await cli(project, "extract");
    await translateAll(project);
    project.write(
      "messages/nb.po",
      project.read("messages/nb.po").replace('msgstr "Ordre {id}"', 'msgstr "Order {id}"')
    );
    expect((await check(project)).report.problems.map(({ code, key }) => [code, key])).toEqual([
      ["TranslationIdenticalToSource", "Order {id}"],
    ]);
  });

  const flagged = '#, ignore-same\nmsgid "Order {id}"';

  it("accepts an identical translation flagged ignore-same, and extract keeps the flag", async ({
    project,
  }) => {
    await cli(project, "extract");
    await translateAll(project);
    project.write(
      "messages/nb.po",
      project
        .read("messages/nb.po")
        .replace('msgid "Order {id}"', flagged)
        .replace('msgstr "Ordre {id}"', 'msgstr "Order {id}"')
    );
    expect((await cli(project, "extract")).code).toBe(0);
    expect(project.read("messages/nb.po")).toContain(flagged);
    const { code, report } = await check(project);
    expect([code, report.problems]).toEqual([0, []]);
  });

  // Oracle: GNU msgcat 1.0, which reads every `#,` line of an entry and writes one, comma-separated, `fuzzy` first.
  it.for([
    ["split, ignore-same first", "#, ignore-same\n#, fuzzy"],
    ["split, fuzzy first", "#, fuzzy\n#, ignore-same"],
    ["one line", "#, ignore-same, fuzzy"],
  ])("keeps every flag when they are %s", async ([_label, flagLines], { project }) => {
    await cli(project, "extract");
    await translateAll(project);
    project.write(
      "messages/nb.po",
      project
        .read("messages/nb.po")
        .replace('msgid "Order {id}"', `${flagLines}\nmsgid "Order {id}"`)
        .replace('msgstr "Ordre {id}"', 'msgstr "Order {id}"')
    );
    expect((await check(project)).report.problems).toEqual([]);
    expect((await cli(project, "extract")).code).toBe(0);
    expect(project.read("messages/nb.po")).toContain('#, fuzzy, ignore-same\nmsgid "Order {id}"');
    const { code, report } = await check(project);
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
  it.for([
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
  ] as const)(
    "keeps each entry's flags to itself when %s",
    async ([_label, entries, extracted], { project }) => {
      await cli(project, "extract");
      await translateAll(project);
      project.write(
        "messages/nb.po",
        project.read("messages/nb.po").replace(`${openEntry}\n${orderEntry}`, entries)
      );
      const problems = async (): Promise<[number, Array<[string, string | undefined]>]> => {
        const { code, report } = await check(project);

        return [code, report.problems.map((problem) => [problem.code, problem.key])];
      };
      const identical = [1, [["TranslationIdenticalToSource", "Order {id}"]]];
      expect(await problems()).toEqual(identical);
      expect((await cli(project, "extract")).code).toBe(0);
      expect(project.read("messages/nb.po").slice(-extracted.length - 2)).toBe(`\n\n${extracted}`);
      expect(await problems()).toEqual(identical);
    }
  );

  it("reports an ignore-same flag on a translation that differs from its source", async ({ project }) => {
    await cli(project, "extract");
    await translateAll(project);
    project.write("messages/nb.po", project.read("messages/nb.po").replace('msgid "Order {id}"', flagged));
    expect((await check(project)).report.problems.map(({ code, key }) => [code, key])).toEqual([
      ["IgnoreSameUnused", "Order {id}"],
    ]);
  });

  it("extracts a <Select> inside <T> and checks its translation", async ({ project }) => {
    project.write(
      "src/pick.tsx",
      `import { T, Select } from "@elmeragroup/intl/react";\nexport const Pick = ({ kind }: { kind: string }) => <T>Pick <b><Select kind={kind} _a="A" other="O" /></b></T>;\n`
    );
    await cli(project, "extract");
    await translateAll(project);
    const source = 'msgid "Pick <x0>{kind, select, a {A} other {O}}</x0>"\nmsgstr ""';
    expect(project.read("messages/nb.po")).toContain(source);
    project.write(
      "messages/nb.po",
      project
        .read("messages/nb.po")
        .replace(
          source,
          source.replace('msgstr ""', 'msgstr "Velg <x0>{kind, select, a {Å} other {Ø}}</x0>"')
        )
    );
    const { code, report } = await check(project);
    expect([code, report.problems]).toEqual([0, []]);
  });

  it("accepts a text placeholder used as a select", async ({ project }) => {
    await cli(project, "extract");
    await translateAll(project);
    project.write(
      "messages/nb.po",
      project
        .read("messages/nb.po")
        .replace('msgstr "Ordre {id}"', 'msgstr "Ordre {id, select, other {{id}}}"')
    );
    await cli(project, "extract");
    expect(await codes(project)).toEqual([]);
  });

  // A plain `{x}` takes text only, so a number or date shown plainly fails at runtime, and text formatted as a number renders NaN.
  it.for([
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
  ] as const)("judges %s", async ([_label, source, translation, expected], { project }) => {
    project.write(
      "src/kinds.tsx",
      `import { msg } from "@elmeragroup/intl/react";\nexport const d = msg(${JSON.stringify(source)});\n`
    );
    await cli(project, "extract");
    await translateAll(project);
    project.write(
      "messages/nb.po",
      project
        .read("messages/nb.po")
        .replace(
          `msgid ${JSON.stringify(source)}\nmsgstr ""`,
          `msgid ${JSON.stringify(source)}\nmsgstr ${JSON.stringify(translation)}`
        )
    );
    await cli(project, "extract");
    expect(await codes(project)).toEqual(expected);
  });

  it("reports a dropped tag", async ({ project }) => {
    await cli(project, "extract");
    await translateAll(project);
    const po = project.read("messages/nb.po");
    project.write(
      "messages/nb.po",
      po.replace("Hei {name}, les <x0>vilkårene</x0>.", "Hei {name}, les vilkårene.")
    );
    await cli(project, "extract");
    expect(await codes(project)).toEqual(["TagMismatch"]);
  });

  it("accepts reordered tags", async ({ project }) => {
    project.write(
      "src/two.tsx",
      `import { T } from "@elmeragroup/intl/react";\nexport const two = <T>Read <a href="/a">this</a> and <b>that</b></T>;\n`
    );
    await cli(project, "extract");
    await translateAll(project);
    const source = "Read <x0>this</x0> and <x1>that</x1>";
    const po = project.read("messages/nb.po");
    project.write(
      "messages/nb.po",
      po.replace(
        `msgid "${source}"\nmsgstr ""`,
        `msgid "${source}"\nmsgstr "Les <x1>det</x1> og <x0>dette</x0>"`
      )
    );
    await cli(project, "extract");
    expect(await codes(project)).toEqual([]);
  });

  it("reports a catalog keyed by another serializer version, and extract refuses to rewrite it", async ({
    project,
  }) => {
    await cli(project, "extract");
    await translateAll(project);
    const stale = project.read("messages/nb.po").replace("X-Elmera-Serializer: 1", "X-Elmera-Serializer: 0");
    project.write("messages/nb.po", stale);
    const { report } = await check(project);
    expect(report.problems.map((problem) => problem.code)).toEqual(["SerializerMismatch"]);
    expect(report.problems[0]?.fix).toContain("move each msgstr to its re-keyed msgid by hand");
    expect((await cli(project, "extract")).code).toBe(1);
    expect(project.read("messages/nb.po")).toBe(stale);
  });

  it("reports a missing catalog", async ({ project }) => {
    expect(await codes(project)).toEqual(["CatalogMissing"]);
  });

  it("reports an include pattern that matches no file, and extract writes nothing", async ({ project }) => {
    project.write(
      "elmera-intl.json",
      JSON.stringify({ ...CONFIG, include: [...CONFIG.include, "missing/**/*.tsx"] })
    );
    expect(await codes(project)).toContain("IncludeUnmatched");
    expect((await cli(project, "extract")).code).toBe(1);
    expect(existsSync(project.path("messages/nb.po"))).toBe(false);
  });

  it("skips a directory whose name matches an include pattern", async ({ project }) => {
    await cli(project, "extract");
    await translateAll(project);
    project.write("src/odd.tsx/readme.md", "a directory named like a source file");
    const { code, report } = await check(project);
    expect([code, report.ok]).toEqual([0, true]);
  });

  it("skips a dangling symlink that matches an include pattern", async ({ project }) => {
    await cli(project, "extract");
    await translateAll(project);
    symlinkSync(project.path("src/deleted.tsx"), project.path("src/dangling.tsx"));
    const { code, report } = await check(project);
    expect([code, report.ok]).toEqual([0, true]);
  });

  // Oracle: the report tooling parses, written out by hand: two-space indentation, keys in the order ok, problems,
  // messages, written, unreachable, and a trailing newline.
  it("writes only the JSON report to stdout", BIN_TEST, async ({ project }) => {
    await cli(project, "extract");
    const untranslated = (key: string) => `    {
      "code": "TranslationMissing",
      "message": "untranslated",
      "fix": "translate it in messages/nb.po, then run \`elmera-intl extract\`",
      "file": "messages/nb.po",
      "locale": "nb",
      "key": ${key}
    }`;
    const { code, stdout, stderr } = bin(project, "check", "--json");
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

describe("usage", BIN_TEST, () => {
  // Oracle: the usage text, written out by hand.
  const USAGE = `usage: elmera-intl <extract|check> [--json] [--config <path to elmera-intl.json>]
       elmera-intl extract --watch [--poll <ms>] [--config <path to elmera-intl.json>]
`;

  it.for([
    ["an unknown command", ["translate"], "unknown command: translate"],
    ["no command", [], "unknown command: (none)"],
    ["an unknown flag", ["check", "--unknown", "--json"], "unexpected argument: --unknown"],
    ["--config without a value", ["check", "--config"], "--config needs a path"],
    ["--config followed by a flag", ["check", "--config", "--json"], "--config needs a path"],
    ["a stray argument", ["check", "extra"], "unexpected argument: extra"],
    ["a repeated flag", ["check", "--json", "--json"], "unexpected argument: --json"],
    // Flag values only as separate arguments, and no `--` terminator: both are arguments the parser rejects.
    ["a flag with an inline value", ["check", "--json=yes"], "unexpected argument: --json=yes"],
    ["an argument terminator", ["check", "--"], "unexpected argument: --"],
    // effect/cli's lexer would read each of these differently: a flag given its value, `--` as the end of the flags
    // (leaving `--json` an argument), and `-hj` as two short flags. Bytes from the layer 1 parser.
    [
      "a value flag with an inline value",
      ["check", "--config=x.json"],
      "unexpected argument: --config=x.json",
    ],
    ["a boolean flag with an inline false", ["check", "--json=false"], "unexpected argument: --json=false"],
    ["an argument terminator before a flag", ["check", "--", "--json"], "unexpected argument: --"],
    ["a cluster of short flags", ["check", "-hj"], "unexpected argument: -hj"],
    ["an inline value in the command's place", ["--json=1", "check"], "unknown command: --json=1"],
    // The first failing argument, reading left to right, where effect/cli reports flags before arguments.
    ["a stray argument before an unknown flag", ["check", "extra", "--jsn"], "unexpected argument: extra"],
    [
      "a repeated --config with no value",
      ["check", "--config", "a", "--config"],
      "unexpected argument: --config",
    ],
    [
      "an out-of-range --poll before its repeat",
      ["extract", "--watch", "--poll", "5", "--poll", "9"],
      "--poll 5: the interval must be between 10 and 2147483647 milliseconds",
    ],
    // effect/cli's lexer reads `-5` as a value, which a numeric flag would parse; the contract takes digits only.
    // The booleans are presence-only: no negated form, and a value never attaches to one. Bytes from layer 1.
    ["a negated --json", ["extract", "--no-json"], "unexpected argument: --no-json"],
    ["a value after --json", ["extract", "--json", "false"], "unexpected argument: false"],
    ["a value after --watch", ["extract", "--watch", "false"], "unexpected argument: false"],
    ["a negated --watch", ["extract", "--no-watch"], "unexpected argument: --no-watch"],
    // A --poll value is judged as an interval, whatever it reads like.
    [
      "--poll with words for an interval",
      ["extract", "--watch", "--poll", "2 occurrences"],
      "--poll needs an interval in milliseconds, such as --poll 200",
    ],
    [
      "--poll with a negative interval",
      ["extract", "--watch", "--poll", "-5"],
      "--poll needs an interval in milliseconds, such as --poll 200",
    ],
    // --watch runs instead of exiting; with check or --json it is refused before anything starts.
    ["--watch with check", ["check", "--watch"], "--watch goes with extract only, without --json"],
    [
      "--watch with --json",
      ["extract", "--watch", "--json"],
      "--watch goes with extract only, without --json",
    ],
    // `--poll` takes a whole number of milliseconds from 10 to 2^31 - 1, and only with `--watch`: Node turns a delay
    // past 2^31 - 1 ms into 1 ms, which would scan without pause, and under 10 ms a walk per tick is a continuous scan.
    ["--poll without --watch", ["extract", "--poll", "50"], "--poll goes with extract --watch only"],
    [
      "--poll with no interval",
      ["extract", "--watch", "--poll"],
      "--poll needs an interval in milliseconds, such as --poll 200",
    ],
    [
      "--poll with a zero interval",
      ["extract", "--watch", "--poll", "0"],
      "--poll 0: the interval must be between 10 and 2147483647 milliseconds",
    ],
    [
      "--poll with a fraction",
      ["extract", "--watch", "--poll", "1.5"],
      "--poll needs an interval in milliseconds, such as --poll 200",
    ],
    [
      "--poll past Node's timer range",
      ["extract", "--watch", "--poll", "2147483648"],
      "--poll 2147483648: the interval must be between 10 and 2147483647 milliseconds",
    ],
    [
      "--poll under the 10 ms floor",
      ["extract", "--watch", "--poll", "5"],
      "--poll 5: the interval must be between 10 and 2147483647 milliseconds",
    ],
  ] as const)("exits 2 with usage on %s", ([_label, args, reason], { project }) => {
    const { code, stdout, stderr } = bin(project, ...args);
    expect([code, stdout]).toEqual([2, ""]);
    expect(stderr).toBe(`${reason}\n${USAGE}`);
    // Refused before anything runs: no catalog is written.
    expect(existsSync(project.path("messages"))).toBe(false);
  });

  // `--config` takes the next argument as its path unless it starts with `--`, so `-x` is a path (one that does not
  // exist), where effect/cli's lexer would read a short flag and report the path missing.
  it("takes an argument that looks like a short flag as the --config path", ({ project }) => {
    const { code, stdout, stderr } = bin(project, "check", "--config", "-x");
    const path = join(realpathSync(project.root), "-x");
    expect([code, stdout]).toEqual([1, "0 messages; 1 problem(s)\n"]);
    expect(stderr.split("\n")[0]).toBe(`${path}: ConfigInvalid: ${path} not found`);
  });

  // Unit under test: `cliProgram` under a host's own effect/cli settings, as a host runtime that provides Node's
  // services may (layer 4). Oracle: the usage row for `--poll abc` above. The host's built-in flags and presenter must
  // change neither the grammar nor where the output goes: its presenter is never called.
  it("keeps its usage errors to the Reporter under a host's effect/cli settings", async ({ project }) => {
    const presented: Array<string> = [];
    const settings = Layer.merge(
      CliConfig.layer(),
      CliOutput.layerPresenter({
        present: (event) =>
          Effect.sync(() => {
            presented.push(event._tag);
          }),
      })
    );
    const { code, stdout, stderr } = await inProcess(
      project,
      ["extract", "--watch", "--poll", "abc"],
      settings
    );

    expect([code, presented, stdout]).toEqual([2, [], ""]);
    expect(stderr).toBe(`--poll needs an interval in milliseconds, such as --poll 200\n${USAGE}`);
  });

  // Unit under test: `cliProgram` under a host runtime whose effect/cli settings carry a global setting of its own, one
  // whose flag is required. Oracle: the usage row for `check --watch` above: no setting a host provides is part of the
  // CLI's grammar.
  it("keeps its grammar under a host's own global setting", async ({ project }) => {
    // A setting in the place of effect/cli's `--log-level`, with a flag of its own that every invocation would need.
    const hostSetting = GlobalFlag.Setting("log-level")({
      flag: Flag.String("region").pipe(Flag.map(() => Option.none<LogLevel.LogLevel>())),
    });
    const { code, stdout, stderr } = await inProcess(
      project,
      ["check", "--watch"],
      CliConfig.layer({ builtIns: [hostSetting] })
    );

    expect([code, stdout]).toEqual([2, ""]);
    expect(stderr).toBe(`--watch goes with extract only, without --json\n${USAGE}`);
  });

  it("names the fix for a missing config", async ({ project }) => {
    rmSync(project.path("elmera-intl.json"));
    const { code, stderr } = await cli(project, "check");
    expect(code).toBe(1);
    expect(stderr).toContain("ConfigInvalid");
    expect(stderr).toContain('fix: write elmera-intl.json as { "include"');
  });

  // The watcher never sees a file outside the root, so extraction must not scan one either.
  it.for([
    ["include", "src/../../shared/**/*.tsx", '"../shared/**/*.tsx"'],
    ["exclude", "/abs/**", '"/abs/**"'],
  ] as const)(
    "rejects an %s pattern reaching outside the project root",
    async ([field, pattern, reported], { project }) => {
      project.write("elmera-intl.json", JSON.stringify({ ...CONFIG, [field]: [pattern] }));
      const { code, stderr } = await cli(project, "check");
      expect(code).toBe(1);
      expect(stderr).toContain(`glob ${reported} reaches outside the project root`);
    }
  );
});

describe("bin", BIN_TEST, () => {
  it("writes a JSON report larger than a pipe buffer in full", async ({ project }) => {
    project.write(
      "src/many.ts",
      `import { msg } from "@elmeragroup/intl/react";\n${Array.from({ length: 1500 }, (_, i) => `msg("Message number ${i} with some padding text");`).join("\n")}\n`
    );
    // Every message untranslated: one problem each.
    expect((await cli(project, "extract")).code).toBe(0);
    const run = spawnSync(execPath, [BIN, "check", "--json"], {
      cwd: project.root,
      encoding: "utf8",
      ...project.spawnGuard(),
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(run.stdout.length).toBeGreaterThan(65536);
    expect([run.status, readReport(run.stdout).problems.length]).toEqual([1, 1503]);
  });

  it("exits 2 and names the failure when the CLI throws", ({ project }) => {
    // A file where the catalog directory goes: extract's mkdir throws, an I/O failure the CLI does not classify.
    project.write("messages", "");
    const run = bin(project, "extract");
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/^elmera-intl failed: Error:/u);
  });

  // Only a running watch takes SIGINT and SIGTERM: a one-shot command, and a watch still reading its config, keep Node's
  // default, so a signal ends the process at once, with no output. Oracle: the layer 1 executable, which installed its
  // handlers only once a watch's config had loaded: killed by the signal, no exit code, nothing written. The config is
  // a FIFO the test opens and never writes, so the CLI is blocked reading it when the signal lands (the writer's open
  // resolves once the CLI opens it to read), and stays blocked unless the signal ends it.
  it.for([
    ["a check", "SIGINT", ["check"]],
    ["a check", "SIGTERM", ["check"]],
    ["a watch reading its config", "SIGINT", ["extract", "--watch"]],
    ["a watch reading its config", "SIGTERM", ["extract", "--watch"]],
  ] as const)("ends %s at once on %s", async ([_label, signal, args], { project }) => {
    execFileSync("mkfifo", [project.path("fifo.json")]);
    // A hang guard: a CLI that outlived the signal is still blocked on the config, and ends by SIGKILL instead.
    const child = spawn(execPath, [BIN, ...args, "--config", "fifo.json"], {
      cwd: project.root,
      ...project.spawnGuard(),
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      output += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      output += text;
    });
    const closed = new Promise<readonly [number | null, NodeJS.Signals | null]>((done) => {
      child.on("close", (code, killedBy) => {
        done([code, killedBy]);
      });
    });
    const config = await project.openFifoWriter("fifo.json");
    child.kill(signal);
    const ended = await closed;
    config.close();

    expect([...ended, output]).toEqual([null, signal, ""]);
  });

  it("exits quietly when the reader closes the pipe early", async ({ project }) => {
    project.write(
      "src/many.ts",
      `import { msg } from "@elmeragroup/intl/react";\n${Array.from({ length: 1500 }, (_, i) => `msg("Message number ${i} with some padding text");`).join("\n")}\n`
    );
    expect((await cli(project, "extract")).code).toBe(0);
    const child = spawn(execPath, [BIN, "check", "--json"], { cwd: project.root, ...project.spawnGuard() });
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
