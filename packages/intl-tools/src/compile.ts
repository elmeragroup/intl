// The one catalog compiler: PO text and a locale in, the runtime's compiled catalog out. A catalog import on every host
// (catalog-import.ts), `loadCatalog` and `check` all call `compileCatalog`, so dev, build, tests and scripts compile
// alike, and nothing is written to disk: the PO is the only checked-in catalog, so no task needs a generate step
// ordered first.
//
// The artifact is validated, not the parse: every emitted entry goes through JSON as it ships, decodes back to the
// parsed AST, and is dry-formatted from the decoded form through the runtime's own `formatAst` (node pass, then branch
// pass), so a translation that would throw at runtime fails the compile instead.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { Catalog, IrNodes } from "@elmeragroup/intl/internal/catalog";
import {
  decodeAst,
  encodeAst,
  isLiteralSource,
  makeCatalog,
  SOURCE_LOCALE,
} from "@elmeragroup/intl/internal/catalog";
import type { Formats, MessageFormatElement, RichValues } from "@elmeragroup/intl/internal/icu";
import { formatAst, fromAst, resolveFormats } from "@elmeragroup/intl/internal/icu";
import { hashKey, keyOf } from "@elmeragroup/intl/internal/message";

import { parseIcu } from "./icu-parse";
import { parsePo } from "./po";

/** Options of `compileCatalog`. */
export type CompileOptions = {
  /** The app's named styles (its `formats`), which the dry-format resolves as the runtime will. */
  readonly formats?: Formats | undefined;
};

/**
 * Which step rejected an entry. `probe` is a branch sample that rendered another arm than the one it was derived for:
 * the sampler and the runtime disagree on selection (an @elmeragroup/intl defect).
 */
export type CompilePass = "po" | "parse" | "collision" | "codec" | "node" | "branch" | "probe";

/** One entry that failed to compile. */
export type CompileProblem = {
  /** `keyOf(source, context)`; empty for a problem with the file itself. */
  readonly key: string;
  readonly pass: CompilePass;
  readonly reason: string;
  /** Whether the entry compiled from the English source (no translation): its problem is the source's. */
  readonly english: boolean;
};

/**
 * Why the branch pass formats no value through an arm. None fails the compile: the node pass formats the arm's nodes.
 *
 * - `category-absent`: the locale's plural rules have no such category.
 * - `shadowed`: proven dead by the path: an enclosing selector on the same argument, or exact `=N` keys, take every value
 *   that would select it.
 * - `not-sampled`: the search found no value, without proving none exists.
 */
export type UnreachableReason = "category-absent" | "shadowed" | "not-sampled";

/** A plural or select arm the branch pass does not reach. */
export type UnreachableArm = {
  readonly locale: string;
  /** `keyOf(source, context)` of the entry. */
  readonly key: string;
  /** The arm with every arm enclosing it, outermost first: `n:one>n:other`. */
  readonly arm: string;
  readonly reason: UnreachableReason;
};

/** A compiled catalog and what the compile saw. */
export type Compiled = {
  readonly _tag: "Compiled";
  readonly catalog: Catalog;
  /** Entries compiled. */
  readonly keys: number;
  /** Entries left out because they render as their own source. */
  readonly omitted: number;
  /** Plural and select arms the branch pass does not reach, each with why. The node pass still formats their nodes. */
  readonly unreachable: ReadonlyArray<UnreachableArm>;
  /** Dry-format calls made. */
  readonly formatted: number;
};

/**
 * A catalog that does not compile: a PO it cannot read, a collision, a parse, codec or dry-format failure, or a branch
 * sample that rendered another arm.
 */
export class CatalogCompileError extends Error {
  /** The error's tag. */
  readonly _tag = "CatalogCompileError" as const;
  /** The locale compiled for. */
  readonly locale: string;
  /** Every failing entry. */
  readonly problems: ReadonlyArray<CompileProblem>;

  /**
   * List the problems.
   *
   * @param locale - The locale compiled for.
   * @param problems - Every failing entry.
   */
  constructor(locale: string, problems: ReadonlyArray<CompileProblem>) {
    super(
      `elmera-intl: the ${locale} catalog does not compile (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n${problems
        .map((problem) => `  [${problem.pass}] ${JSON.stringify(problem.key)}: ${problem.reason}`)
        .join("\n")}`
    );
    this.locale = locale;
    this.problems = problems;
  }
}

/**
 * Compile a PO catalog for one locale. `en` compiles every msgid. Another locale compiles each translation, and an
 * untranslated entry's English source marked English (it formats in `en`), so each locale's catalog is complete. An
 * entry that renders as its own source is left out, by the runtime's `isLiteralSource`.
 *
 * @param po - The PO file's text.
 * @param locale - The locale to compile for.
 * @param options - The app's `formats`.
 * @returns The catalog, or every problem found.
 */
export function compileCatalog(
  po: string,
  locale: string,
  options: CompileOptions = {}
): Compiled | CatalogCompileError {
  const parsed = parsePo(po);

  if (parsed._tag === "PoParseError") {
    return new CatalogCompileError(locale, [{ key: "", pass: "po", reason: parsed.reason, english: false }]);
  }

  const problems: Array<CompileProblem> = [];
  const owners = new Map<string, string>();
  const entries: Array<readonly [string, IrNodes]> = [];
  const english: Array<string> = [];
  const unreachable: Array<UnreachableArm> = [];
  let omitted = 0;
  let formatted = 0;
  for (const entry of parsed.file.entries) {
    const key = keyOf(entry.source, entry.context);
    const hash = hashKey(key);
    const owner = owners.get(hash);

    if (owner !== undefined) {
      problems.push({
        key,
        pass: "collision",
        reason: `wire key ${hash} is also ${JSON.stringify(owner)}'s; give one of them a context`,
        english: false,
      });
      continue;
    }

    owners.set(hash, key);
    const isEnglish = locale !== SOURCE_LOCALE && entry.translation === "";
    const text = locale === SOURCE_LOCALE || isEnglish ? entry.source : entry.translation;
    const formatLocale = isEnglish ? SOURCE_LOCALE : locale;
    const problem = (pass: CompilePass, reason: string) => {
      problems.push({ key, pass, reason, english: isEnglish || locale === SOURCE_LOCALE });
    };
    const ast = parseIcu(text, formatLocale);

    if (ast._tag === "IcuSyntaxError") {
      problem("parse", ast.reason);
      continue;
    }

    const ir = encodeAst(ast.ast);
    const shipped = decodeAst(jsonRoundTrip(ir));

    if (!isDeepStrictEqual(shipped, ast.ast)) {
      problem("codec", "the emitted entry does not decode to the parsed message");
      continue;
    }

    const dry = dryFormat(shipped, formatLocale, options.formats);
    formatted += dry.formatted;
    // One problem per entry: its other samples usually fail for the same option.
    const [failure] = dry.failures;

    if (failure !== undefined) {
      problem(failure.pass, failure.reason);
    }

    unreachable.push(...dry.unreachable.map(({ arm, reason }) => ({ locale, key, arm, reason })));

    if (ir === entry.source && isLiteralSource(entry.source)) {
      omitted += 1;
      continue;
    }

    entries.push([hash, ir]);

    if (isEnglish) {
      english.push(hash);
    }
  }

  if (problems.length > 0) {
    return new CatalogCompileError(locale, problems);
  }

  return {
    _tag: "Compiled",
    catalog: makeCatalog(entries, english),
    keys: owners.size,
    omitted,
    unreachable,
    formatted,
  };
}

/**
 * Compile a PO file from disk, for Node scripts and tests: the floor that needs no bundler. A server hands the result
 * to the client through the provider's props like any catalog.
 *
 * @param path - The `.po` file.
 * @param locale - The locale to compile for; defaults to the file's basename (`no.po` is `no`). Pass `en` for the
 *   source catalog.
 * @param options - The app's `formats`.
 * @returns The catalog, or why the file does not compile (unreadable included).
 */
export function loadCatalog(
  path: string,
  locale: string = basename(path, ".po"),
  options: CompileOptions = {}
): Compiled | CatalogCompileError {
  let po: string;
  try {
    po = readFileSync(path, "utf8");
  } catch (error) {
    return new CatalogCompileError(locale, [
      { key: "", pass: "po", reason: error instanceof Error ? error.message : String(error), english: false },
    ]);
  }

  return compileCatalog(po, locale, options);
}

// What the artifact is after shipping: JSON drops undefined fields and turns -0 into 0, so the codec check compares
// this, not the in-memory IR.
function jsonRoundTrip(ir: IrNodes): IrNodes {
  // SAFETY: JSON.stringify of IR (strings, numbers, arrays and plain objects of them) parses back to the same type;
  // any value JSON changes is exactly what the deep-equal against the parsed AST is there to catch.
  return JSON.parse(JSON.stringify(ir)) as IrNodes;
}

// ---- Dry-format ------------------------------------------------------------------------------------------------

type Failure = { readonly pass: "node" | "branch" | "probe"; readonly reason: string };
type DryFormat = {
  readonly failures: ReadonlyArray<Failure>;
  readonly unreachable: ReadonlyArray<Pick<UnreachableArm, "arm" | "reason">>;
  readonly formatted: number;
};
type Element = MessageFormatElement;
type ArgKind = "text" | "number" | "date" | "select";
type Value = string | number | bigint | Date | ((chunks: Array<unknown>) => string);
// Sample values by argument, and tag renderers by tag name.
type Samples = ReadonlyMap<string, Value>;

// The zone does not change which options Intl accepts; a style's own timeZone is validated as written.
const TIME_ZONE = "UTC";
const SAMPLE_DATE = new Date(Date.UTC(2026, 0, 15, 13, 45));
// Every value type a number node legally takes, signs and fractions included.
const NUMBER_SAMPLES: ReadonlyArray<number | bigint> = [1234567.5, 0, -1, 12n];
// Candidate differences (value minus offset) for a plural category, smallest magnitude first: integers, decimals, then
// the magnitudes only some categories take (French `many` is 1e6 and its multiples), several of each so `=N` keys on
// some cannot use them all up.
const MULTIPLES = /* @__PURE__ */ Array.from({ length: 10 }, (_, i) => i + 1);
const DIFFERENCES = [
  .../* @__PURE__ */ Array.from({ length: 2001 }, (_, i) => i - 1000).toSorted(
    (a, b) => Math.abs(a) - Math.abs(b)
  ),
  0.5,
  1.5,
  2.5,
  0.1,
  1.1,
  0.25,
  100.5,
  .../* @__PURE__ */ [1e6, 1e9].flatMap((magnitude) => MULTIPLES.map((multiple) => magnitude * multiple)),
];
// Inserted at the start of the arm a branch sample targets: rendered only when that arm is the one selected.
const MARKER = "\u0001arm\u0001";
// A select value that matches no key, so `other` is selected.
const NO_MATCH = "\u0002no-match";

/**
 * Dry-format one decoded message. The node pass formats every number, date and time node on its own, in every branch,
 * with each legal value type. The branch pass derives the values that select each plural and select arm with every
 * arm enclosing it, checks through a probe marker that the arm rendered, and formats the message with them; an arm it
 * cannot reach is listed with why.
 *
 * @param ast - The decoded message.
 * @param locale - The locale it formats in (`en` for an English-marker entry).
 * @param formats - The app's named styles.
 * @returns The failures, the arms not reached and the number of format calls.
 */
function dryFormat(ast: ReadonlyArray<Element>, locale: string, formats: Formats | undefined): DryFormat {
  const settings = { locale, timeZone: TIME_ZONE, formats: resolveFormats(formats) };
  const failures: Array<Failure> = [];
  const unreachable: Array<Pick<UnreachableArm, "arm" | "reason">> = [];
  let formatted = 0;
  const run = (pass: Failure["pass"], nodes: ReadonlyArray<Element>, values: Samples): string | undefined => {
    formatted += 1;
    try {
      const output = formatAst<string>(
        fromAst(nodes),
        settings,
        Object.fromEntries(values) satisfies RichValues<string>
      );

      return Array.isArray(output) ? output.join("") : output;
    } catch (error) {
      failures.push({
        pass,
        reason: `${error instanceof Error ? error.message : String(error)} (with ${describe(values)})`,
      });

      return undefined;
    }
  };

  walk(ast, (element) => {
    if (element.type === 2) {
      NUMBER_SAMPLES.forEach((sample) => run("node", [element], new Map([[element.value, sample]])));
    } else if (element.type === 3 || element.type === 4) {
      run("node", [element], new Map([[element.value, SAMPLE_DATE]]));
    }
  });

  const base = new Map<string, Value>([
    ...[...argumentKinds(ast)].map(([name, kind]) => [name, sampleOf(kind)] as const),
    ...tagValues(ast),
  ]);
  run("branch", ast, base);
  for (const arm of arms(ast)) {
    const label = arm.map((step) => `${step.select.value}:${step.key}`).join(">");
    const last = arm.at(-1);
    const reach = reachArm(arm, locale);

    if (reach._tag === "Unreachable") {
      unreachable.push({ arm: label, reason: reach.reason });
      continue;
    }

    if (last === undefined) {
      continue;
    }

    const values = new Map([...base, ...reach.values]);
    const probe = run("branch", withMarker(ast, last.select, last.key), values);

    if (probe === undefined) {
      continue;
    }

    // The search mirrors the runtime's selection, so another arm rendering is a sampler defect, not a dead arm.
    if (!probe.includes(MARKER)) {
      failures.push({
        pass: "probe",
        reason: `the sample for ${label} rendered another arm (${describe(values)})`,
      });
      continue;
    }

    run("branch", ast, values);
    // A plural also takes a bigint: the same integer sample again as one.
    const count = reach.values.get(last.select.value);

    if (last.select.type === 6 && count !== undefined && Number.isInteger(count)) {
      run("branch", ast, new Map([...values, [last.select.value, BigInt(count)]]));
    }
  }

  return { failures, unreachable, formatted };
}

function children(element: Element): ReadonlyArray<ReadonlyArray<Element>> {
  if (element.type === 8) {
    return [element.children];
  }

  if (element.type === 5 || element.type === 6) {
    return Object.values(element.options).map((option) => option.value);
  }

  return [];
}

function walk(ast: ReadonlyArray<Element>, visit: (element: Element) => void): void {
  for (const element of ast) {
    visit(element);
    children(element).forEach((nodes) => {
      walk(nodes, visit);
    });
  }
}

// A number use wins over a plain one: check rejects a message that mixes them, so only the number use is real.
function argumentKinds(ast: ReadonlyArray<Element>): Map<string, ArgKind> {
  const kinds = new Map<string, ArgKind>();
  walk(ast, (element) => {
    if (element.type === 1) {
      kinds.set(element.value, kinds.get(element.value) ?? "text");
    } else if (element.type === 2 || element.type === 6) {
      kinds.set(element.value, "number");
    } else if (element.type === 3 || element.type === 4) {
      kinds.set(element.value, "date");
    } else if (element.type === 5) {
      kinds.set(element.value, kinds.get(element.value) ?? "select");
    }
  });

  return kinds;
}

function sampleOf(kind: ArgKind): Value {
  switch (kind) {
    case "text":
      return "x";
    case "number":
      return 1;
    case "date":
      return SAMPLE_DATE;
    case "select":
      return NO_MATCH;
  }
}

function tagValues(ast: ReadonlyArray<Element>): Samples {
  const tags = new Map<string, Value>();
  walk(ast, (element) => {
    if (element.type === 8) {
      tags.set(element.value, (chunks) => chunks.join(""));
    }
  });

  return tags;
}

type Step = { readonly select: Extract<Element, { type: 5 | 6 }>; readonly key: string };

// Every arm of every plural and select, each with the arms enclosing it.
function arms(ast: ReadonlyArray<Element>, path: ReadonlyArray<Step> = []): Array<ReadonlyArray<Step>> {
  return ast.flatMap((element) => {
    if (element.type === 5 || element.type === 6) {
      return Object.entries(element.options).flatMap(([key, option]) => {
        const here = [...path, { select: element, key }];

        return [here, ...arms(option.value, here)];
      });
    }

    return element.type === 8 ? arms(element.children, path) : [];
  });
}

type Reach =
  | { readonly _tag: "Reached"; readonly values: ReadonlyMap<string, string | number> }
  | { readonly _tag: "Unreachable"; readonly reason: UnreachableReason };

// The values that select every arm on the path. Arms on one argument constrain one value, so it is searched once
// against all of them: an outer `a` fixes the value an inner select on the same argument then sees.
function reachArm(arm: ReadonlyArray<Step>, locale: string): Reach {
  const values = new Map<string, string | number>();
  for (const [name, steps] of Map.groupBy(arm, (step) => step.select.value)) {
    const value = candidates(steps).find((candidate) =>
      steps.every((step) => selects(step, candidate, locale))
    );

    if (value === undefined) {
      return { _tag: "Unreachable", reason: unreachedReason(steps, locale) };
    }

    values.set(name, value);
  }

  return { _tag: "Reached", values };
}

// Why no candidate selects every step on one argument.
function unreachedReason(steps: ReadonlyArray<Step>, locale: string): UnreachableReason {
  const isAbsent = steps.some(
    (step) =>
      step.select.type === 6 &&
      step.key !== "other" &&
      !step.key.startsWith("=") &&
      !pluralRules(locale, step.select.pluralType)
        .resolvedOptions()
        .pluralCategories.some((category) => category === step.key)
  );

  if (isAbsent) {
    return "category-absent";
  }

  // Complete when an `=N` arm leaves N the only value, or when only selects constrain the argument: the candidates
  // then hold a value of every class the runtime tells apart.
  const isComplete =
    steps.some((step) => step.key.startsWith("=")) || steps.every((step) => step.select.type === 5);

  return isComplete || isCategoryDisjoint(steps, locale) ? "shadowed" : "not-sampled";
}

// Plurals of one type and offset on one argument see one category per value. The candidates tried every `=N` key on
// the path, so any other value selects by its category alone; when no category of the locale selects every step's arm,
// no value does. Different types or offsets compute different categories, which this cannot compare.
function isCategoryDisjoint(steps: ReadonlyArray<Step>, locale: string): boolean {
  const plurals = steps.flatMap(({ select, key }) => (select.type === 6 ? [{ select, key }] : []));
  const [first] = plurals;

  if (
    first === undefined ||
    plurals.length !== steps.length ||
    plurals.some(
      ({ select }) => select.pluralType !== first.select.pluralType || select.offset !== first.select.offset
    )
  ) {
    return false;
  }

  return pluralRules(locale, first.select.pluralType)
    .resolvedOptions()
    .pluralCategories.every((category) =>
      plurals.some(
        ({ select, key }) => (Object.hasOwn(select.options, category) ? category : "other") !== key
      )
    );
}

// Values to try for one argument: every select key and one matching none, every `=N`, and each plural's category
// candidates, relative to its offset.
function candidates(steps: ReadonlyArray<Step>): Array<string | number> {
  return [
    ...new Set(
      steps.flatMap(({ select }): Array<string | number> => {
        const keys = Object.keys(select.options);

        if (select.type === 5) {
          return [...keys.filter((key) => key !== "other"), NO_MATCH];
        }

        return [
          ...keys.filter((key) => key.startsWith("=")).map((key) => Number(key.slice(1))),
          ...DIFFERENCES.map((difference) => difference + select.offset),
        ];
      })
    ),
  ];
}

// Whether the runtime (intl-messageformat) selects the step's arm for `value`: a select takes its key or else `other`;
// a plural takes `=value`, else the category of value minus offset (coerced to a number, as the runtime does), else
// `other`.
function selects({ select, key }: Step, value: string | number, locale: string): boolean {
  if (select.type === 5) {
    const chosen = Object.hasOwn(select.options, String(value)) ? String(value) : "other";

    return chosen === key;
  }

  if (Object.hasOwn(select.options, `=${value}`)) {
    return key === `=${value}`;
  }

  const category = pluralRules(locale, select.pluralType).select(Number(value) - select.offset);

  return (Object.hasOwn(select.options, category) ? category : "other") === key;
}

// The search asks thousands of times per message; one Intl.PluralRules per locale and type serves them all.
const PLURAL_RULES = new Map<string, Intl.PluralRules>();

function pluralRules(locale: string, type: Intl.PluralRulesOptions["type"]): Intl.PluralRules {
  const id = `${locale}\u0000${type ?? "cardinal"}`;
  const existing = PLURAL_RULES.get(id);

  if (existing !== undefined) {
    return existing;
  }

  const rules = new Intl.PluralRules(locale, { type });
  PLURAL_RULES.set(id, rules);

  return rules;
}

function withMarker(ast: ReadonlyArray<Element>, target: Element, key: string): Array<Element> {
  return ast.map((element): Element => {
    if (element.type === 5 || element.type === 6) {
      const options = Object.fromEntries(
        Object.entries(element.options).map(([option, { value }]) => {
          const marked = withMarker(value, target, key);

          return [
            option,
            { value: element === target && option === key ? [literal(MARKER), ...marked] : marked },
          ];
        })
      );

      return { ...element, options };
    }

    return element.type === 8 ? { ...element, children: withMarker(element.children, target, key) } : element;
  });
}

function literal(value: string): Element {
  return { type: 0, value };
}

// The samples a failure was formatted with, for its message (tag renderers left out).
function describe(values: Samples): string {
  return [...values]
    .flatMap(([name, value]) =>
      // oxlint-disable-next-line unicorn/no-instanceof-builtins -- the samples are built in this module, in this realm
      value instanceof Function
        ? []
        : [`${name}=${value instanceof Date ? value.toISOString() : String(value)}`]
    )
    .join(", ");
}
