// The one React-children -> message resolver, shared by the client and server <T>.
import type { ReactElement, ReactNode } from "react";
import { cloneElement, Fragment, isValidElement } from "react";

import type { IntlInstance } from "./intl";
import { FORMAT, REPORT, sourceMessage } from "./intl";
import type { ArgProblem, MessageNode, SelectProp } from "./message";
import {
  describeArgProblem,
  describeInvalidCase,
  isPluralForm,
  recordArg,
  selectProp,
  serialize,
} from "./message";

type Primitive = string | number;

/**
 * Props of `<Val>`: exactly one prop, whose name is the plain ICU argument and whose text fills it. A number is not
 * text: format it in the message (`t("{n, number}")`) or pass `String(n)`.
 */
export type ValProps = Readonly<Record<string, string>>;

type PluralCategories = {
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
};

/**
 * Props of `<Plural>`: the plural forms as string literals (`_0` for an exact `=0`, `#` for the count) and exactly
 * one other prop, the count, whose name is the ICU argument.
 */
export type PluralProps = PluralCategories & { readonly [exact: `_${number}`]: string } & Readonly<
    Record<string, Primitive>
  >;

/**
 * A value inside `<T>`: `<Val name={user.name} />` is the ICU argument `{name}`. Outside `<T>` (or when `<T>` falls
 * back to its children) it renders its value prop when that is text or a number, and nothing for any other value, so
 * a stray `<Val>` degrades instead of crashing and never shows invented text (`null`, `[object Object]`).
 *
 * @param props - One prop: the argument name and its value.
 * @returns The value as text, or nothing.
 */
export function Val(props: ValProps): ReactNode {
  return Object.entries<unknown>(props)
    .map(([key, value]) =>
      key !== "children" && (typeof value === "string" || typeof value === "number") ? String(value) : ""
    )
    .join("");
}

/**
 * Props of `<Select>`: the cases as string literals, each named `_` + its select key (`_company`), the required
 * `other`, and exactly one other prop, the value, whose name is the ICU argument. The value is text, as in
 * `t("{x, select, …}")`; `other` makes any text legal.
 */
export type SelectProps = { readonly other: string } & Readonly<Record<string, string>>;

const ENGLISH_PLURALS = new Intl.PluralRules("en");

/**
 * A plural inside `<T>`: `<Plural count={n} one="# order" other="# orders" />`. Outside `<T>` (or when `<T>` falls
 * back to its children) it renders its English form for the count, so the count is never dropped; a form that is not
 * a string counts as unwritten.
 *
 * @param props - The count and the plural forms.
 * @returns The matching English form, `#` replaced by the count, or nothing when the count is not a number.
 */
export function Plural(props: PluralProps): ReactNode {
  const entries = Object.entries<unknown>(props);
  const forms = textsOf(entries.filter(([key]) => isPluralForm(key)));
  const count = entries.find(([key]) => key !== "children" && !isPluralForm(key))?.[1];

  if (typeof count !== "number") {
    return null;
  }

  return (
    forms.get(`_${count}`) ??
    forms.get(ENGLISH_PLURALS.select(count)) ??
    forms.get("other")
  )?.replaceAll("#", String(count));
}

/**
 * A select inside `<T>`: `<Select subject={subject} _company="company" other="customer" />`. Outside `<T>` (or when
 * `<T>` falls back to its children) it renders its English branch for the value. A branch that is not a string, or
 * whose name is no select key (`_other`, `_a-b`), counts as unwritten.
 *
 * @param props - The value, the cases and `other`.
 * @returns The case the value names, else `other`, else nothing.
 */
export function Select(props: SelectProps): ReactNode {
  const entries = Object.entries<unknown>(props);
  const value = entries.find(([key]) => key !== "children" && selectProp(key)._tag === "NotBranch")?.[1];
  const texts = textsOf(entries);
  const branch =
    typeof value === "string" && selectProp(`_${value}`)._tag === "Case" ? texts.get(`_${value}`) : undefined;

  return branch ?? texts.get("other");
}

// The props whose value is a string: a branch or form the developer wrote as text.
function textsOf(entries: ReadonlyArray<[string, unknown]>): Map<string, string> {
  return new Map(entries.filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

type ElementProps = { readonly children?: ReactNode };

/**
 * Render `<T>` children as the translated message.
 *
 * @param intl - The translator for the current locale.
 * @param children - The `<T>` children: text, elements, fragments, `<Val>`, `<Plural>` and `<Select>`.
 * @param context - The `<T context>` prop.
 * @param self - The calling `<T>`, which its message may not contain.
 * @returns The translated content, with the children's elements around their translated text. A `<T>` the extractor
 *   rejects (a reserved or conflicting argument, a malformed `<Val>`, `<Plural>` or `<Select>`, a `<T>` inside it), a
 *   value that is neither text nor a number (which only the prop types rule out), and a message that fails to format
 *   are reported once (to `onError`, or the default), and the children render untranslated, each value as written
 *   and an inner `<T>` translating itself; so do they when the catalog lacks a structured message (not extracted yet).
 *   A present `null` or `undefined` `<Val>` formats as `t()` formats it.
 * @throws When a child is not text or an element (a promise, an object), which `<T>` cannot put in a message.
 */
export function renderT(
  intl: IntlInstance,
  children: ReactNode,
  context: string | undefined,
  self: ReactElement["type"]
): ReactNode {
  const seen: Walk["seen"] = new Map();
  const elements: Array<ReactElement<ElementProps>> = [];
  const problems: Array<Problem> = [];
  const nodes = toNodes(children, { seen, problems, self }, elements);
  const message = sourceMessage(serialize(nodes), context);
  const [problem] = problems;

  if (problem) {
    intl[REPORT](new Error(describeProblem(problem)), message.key);

    return <>{children}</>;
  }

  // `children: undefined` first: with no chunks (`<x0></x0>`) cloneElement would keep the English children.
  const tags = Object.fromEntries(
    elements.map((element, i) => [
      `x${i}`,
      (chunks: Array<ReactNode>) => cloneElement(element, { key: i, children: undefined }, ...chunks),
    ])
  );
  // Object.fromEntries, then a spread: both define own properties, so an argument named `__proto__` reaches the
  // formatter as one. A failed format was reported by FORMAT, outside any try here, so a throwing onError propagates.
  const outcome = intl[FORMAT]<ReactNode>(message, { ...Object.fromEntries(seen), ...tags });

  return outcome._tag === "Formatted" ? <>{outcome.value}</> : <>{children}</>;
}

/**
 * A `<T>` inside the one being rendered: as a tag, its own translation would replace the outer one's text for it, so
 * the outer message cannot render translated (the extractor's rule too).
 */
type NestedT = { readonly _tag: "NestedT" };

type ValueComponent = "Val" | "Plural" | "Select";

/**
 * Why a `<T>` renders its children untranslated: the slot rules' argument problems, a `<T>` inside it, or a
 * `<Val>`/`<Plural>`/`<Select>` the extractor rejects or whose value is not text or a number. Each names the fix.
 */
type Problem =
  | ArgProblem
  | NestedT
  /** A `<Select>` branch name that is no select key. */
  | Extract<SelectProp, { readonly _tag: "InvalidCase" }>
  /** A `<Select>` without `other`. */
  | { readonly _tag: "MissingOther" }
  /** A `<Plural>` form or `<Select>` branch that is not a string. */
  | { readonly _tag: "PartNotText"; readonly component: "Plural" | "Select"; readonly key: string }
  /** Zero or several value props. */
  | { readonly _tag: "ValueProps"; readonly component: ValueComponent; readonly names: ReadonlyArray<string> }
  /** A value that is neither text nor a number. */
  | { readonly _tag: "ValueNotText"; readonly component: ValueComponent; readonly name: string };

function describeProblem(problem: Problem): string {
  switch (problem._tag) {
    case "NestedT":
      return "<T> cannot contain another <T>; keep the whole text in the outer <T>";
    case "InvalidCase":
      return describeInvalidCase(problem.name);
    case "MissingOther":
      return "<Select> needs an `other` branch";
    case "PartNotText":
      return `<${problem.component} ${problem.key}> needs a string literal ${problem.component === "Plural" ? "form" : "branch"}`;
    case "ValueProps":
      return `<${problem.component}> needs exactly one value prop, got ${problem.names.join(", ") || "none"}`;
    case "ValueNotText":
      return `<${problem.component} ${problem.name}> needs a string or number value`;
    default:
      return describeArgProblem(problem);
  }
}

/** What one `<T>`'s message walk carries: where it collects the arguments, and the `<T>` it may not meet again. */
type Walk = {
  /**
   * Each registered `<Val>`/`<Plural>`/`<Select>` value by argument name, for the shared slot rules and the formatter:
   * text or a number, or a `<Val>`'s present `null`/`undefined`, which formats as `t()` formats it.
   */
  readonly seen: Map<string, Primitive | null | undefined>;
  /** Receives each problem that keeps the message untranslated, in the order the walk meets them. */
  readonly problems: Array<Problem>;
  /**
   * The calling `<T>`. `/react` resolves to one `T` per environment, so a `<T>` written inside it is this function;
   * a second loaded copy of the package is not caught.
   */
  readonly self: ReactElement["type"];
};

/**
 * Turn `<T>` children into message parts, collecting argument values and the elements behind positional tags.
 *
 * @param children - The children to read.
 * @param walk - Receives the arguments and the problems that keep the message untranslated, and names the calling
 *   `<T>`.
 * @param elements - Receives each element, in tag order.
 * @returns The message parts; a malformed `<Val>`, `<Plural>` or `<Select>` adds none.
 * @throws On a child that is not text or an element (see `renderT`).
 */
function toNodes(
  children: ReactNode,
  walk: Walk,
  elements: Array<ReactElement<ElementProps>>
): Array<MessageNode> {
  const nodes: Array<MessageNode> = [];
  const list: ReadonlyArray<ReactNode> = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === true || child === false) {
      continue;
    }

    if (typeof child === "string" || typeof child === "number") {
      nodes.push({ kind: "text", text: String(child) });
      continue;
    }

    if (Array.isArray(child)) {
      nodes.push(...toNodes(child, walk, elements));
      continue;
    }

    if (!isValidElement<ElementProps>(child)) {
      throw new Error(
        `<T> child is not text, an element, <Val>, <Plural> or <Select>: ${Object.prototype.toString.call(child)}`
      );
    }

    // Read on as a tag, so the message (and its key) stays the one the walk computes; renderT reports it.
    if (child.type === walk.self) {
      walk.problems.push({ _tag: "NestedT" });
    }

    if (child.type === Fragment) {
      nodes.push(...toNodes(child.props.children, walk, elements));
      continue;
    }

    const component: ValueComponent | undefined =
      child.type === Val
        ? "Val"
        : child.type === Plural
          ? "Plural"
          : child.type === Select
            ? "Select"
            : undefined;

    if (component === undefined) {
      const index = elements.push(child) - 1;
      nodes.push({ kind: "el", index, children: toNodes(child.props.children, walk, elements) });
      continue;
    }

    const node = valueNode(child, component, walk);

    if (node) {
      nodes.push(node);
    }
  }

  return nodes;
}

/**
 * Read a `<Val>`, `<Plural>` or `<Select>` into its message part, pushing each problem in order: the value props'
 * count, the value's kind, then each form or branch in prop order, then a missing `other`. Only a well-formed
 * component whose value is text or a number (or a `<Val>`'s present `null`/`undefined`) registers its argument, so a
 * malformed one reports its own shape, never a slot rule on the name it carries.
 *
 * @returns The part, or `undefined` for a malformed component, which adds nothing to the message.
 */
function valueNode(
  element: ReactElement<ElementProps>,
  component: ValueComponent,
  walk: Walk
): MessageNode | undefined {
  const entries = propEntries(element);
  // Branch names (one, other, _0, _company…) are reserved only on <Plural>/<Select>; <Val one={1} /> is a value
  // named "one".
  const args = entries.filter(
    ([key]) =>
      key !== "children" &&
      !(component === "Plural"
        ? isPluralForm(key)
        : component === "Select" && selectProp(key)._tag !== "NotBranch")
  );
  const [arg] = args;

  if (args.length !== 1 || arg === undefined) {
    walk.problems.push({ _tag: "ValueProps", component, names: args.map(([key]) => key) });

    return undefined;
  }

  const [name, value] = arg;
  // The walk's Primitive, not MessageValue, which admits a bigint and a Date.
  const isValue =
    typeof value === "string" ||
    typeof value === "number" ||
    (component === "Val" && (value === null || value === undefined));

  if (!isValue) {
    walk.problems.push({ _tag: "ValueNotText", component, name });
  }

  const node: MessageNode | undefined =
    component === "Val"
      ? { kind: "arg", name }
      : component === "Plural"
        ? pluralNode(entries, name, walk)
        : selectNode(entries, name, walk);

  if (node && isValue) {
    const problem = recordArg(walk.seen, name, value);

    if (problem) {
      walk.problems.push(problem);
    }
  }

  return node;
}

// A malformed form or branch adds no part (`undefined`, each problem pushed), which also keeps non-text out of
// serialize, whose escaping would throw on it.
function pluralNode(
  entries: ReadonlyArray<[string, unknown]>,
  name: string,
  walk: Walk
): MessageNode | undefined {
  const before = walk.problems.length;
  const forms: Array<[string, string]> = [];
  for (const [key, form] of entries) {
    if (!isPluralForm(key)) {
      continue;
    }

    if (typeof form === "string") {
      forms.push([key, form]);
    } else {
      walk.problems.push({ _tag: "PartNotText", component: "Plural", key });
    }
  }

  return walk.problems.length > before
    ? undefined
    : { kind: "plural", name, forms: Object.fromEntries(forms) };
}

function selectNode(
  entries: ReadonlyArray<[string, unknown]>,
  name: string,
  walk: Walk
): MessageNode | undefined {
  const before = walk.problems.length;
  const cases: Array<readonly [string, string]> = [];
  let other: string | undefined;
  for (const [key, text] of entries) {
    const prop = selectProp(key);

    if (prop._tag === "NotBranch") {
      continue;
    }

    if (prop._tag === "InvalidCase") {
      walk.problems.push(prop);
    } else if (typeof text !== "string") {
      walk.problems.push({ _tag: "PartNotText", component: "Select", key });
    } else if (prop._tag === "Other") {
      other = text;
    } else {
      cases.push([prop.key, text]);
    }
  }

  // After the branches, and only when none was malformed: a malformed branch is already this component's first
  // problem, and an `other` that is not text was reported as such.
  if (other === undefined && walk.problems.length === before) {
    walk.problems.push({ _tag: "MissingOther" });
  }

  return walk.problems.length > before || other === undefined
    ? undefined
    : { kind: "select", name, cases, other };
}

// Element props have no static type at this boundary: <Val>/<Plural>/<Select> props are read and checked here.
function propEntries(element: ReactElement<ElementProps>): Array<[string, unknown]> {
  return Object.entries(element.props);
}
