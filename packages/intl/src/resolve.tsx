// The one React-children -> message resolver, shared by the client and server <T>.
import type { ReactElement, ReactNode } from "react";
import { cloneElement, Fragment, isValidElement } from "react";

import type { IntlInstance, MessageValue } from "./intl";
import { FORMAT, REPORT, sourceMessage } from "./intl";
import type { ArgProblem, MessageNode } from "./message";
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
 * A value inside `<T>`: `<Val name={user.name} />` is the ICU argument `{name}`. Outside `<T>` it renders its value,
 * so a stray `<Val>` degrades instead of crashing.
 *
 * @param props - One prop: the argument name and its value.
 * @returns The value as text.
 */
export function Val(props: ValProps): ReactNode {
  return Object.values(props).map(String).join("");
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
 * back to its children) it renders its English form for the count, so the count is never dropped.
 *
 * @param props - The count and the plural forms.
 * @returns The matching English form, `#` replaced by the count.
 */
export function Plural(props: PluralProps): ReactNode {
  const entries = Object.entries(props);
  const forms = new Map(entries.filter(([key]) => isPluralForm(key)));
  const count = entries.find(([key]) => key !== "children" && !isPluralForm(key))?.[1];

  if (typeof count !== "number") {
    return null;
  }

  const form = forms.get(`_${count}`) ?? forms.get(ENGLISH_PLURALS.select(count)) ?? forms.get("other");

  return typeof form === "string" ? form.replaceAll("#", String(count)) : null;
}

/**
 * A select inside `<T>`: `<Select subject={subject} _company="company" other="customer" />`. Outside `<T>` (or when
 * `<T>` falls back to its children) it renders its English branch for the value.
 *
 * @param props - The value, the cases and `other`.
 * @returns The case the value names, else `other`.
 */
export function Select(props: SelectProps): ReactNode {
  const entries = Object.entries(props);
  const value = entries.find(([key]) => key !== "children" && selectProp(key)._tag === "NotBranch")?.[1];
  const branch = typeof value === "string" ? entries.find(([key]) => key === `_${value}`)?.[1] : undefined;

  return branch ?? props.other;
}

type ElementProps = { readonly children?: ReactNode };

/**
 * Render `<T>` children as the translated message.
 *
 * @param intl - The translator for the current locale.
 * @param children - The `<T>` children: text, elements, fragments, `<Val>`, `<Plural>` and `<Select>`.
 * @param context - The `<T context>` prop.
 * @returns The translated content, with the children's elements around their translated text. An argument the
 *   extractor rejects (a reserved name, one name with two values) is reported to `onError`, and the children render
 *   untranslated, so every value shows as written; so do they when the catalog lacks a structured message (not
 *   extracted yet).
 * @throws When a child is not text, an element, `<Val>`, `<Plural>` or `<Select>`, a value component lacks its one
 *   value prop, or a `<Select>` branch is malformed: the extractor rejects each, so reaching this is a defect.
 */
export function renderT(intl: IntlInstance, children: ReactNode, context: string | undefined): ReactNode {
  const values: Record<string, MessageValue> = {};
  const elements: Array<ReactElement<ElementProps>> = [];
  const problems: Array<ArgProblem> = [];
  const nodes = toNodes(children, { values, seen: new Map(), problems }, elements);
  const message = sourceMessage(serialize(nodes), context);
  const [problem] = problems;

  if (problem) {
    intl[REPORT](new Error(describeArgProblem(problem)), message.key);

    return <>{children}</>;
  }

  // `children: undefined` first: with no chunks (`<x0></x0>`) cloneElement would keep the English children.
  const tags = Object.fromEntries(
    elements.map((element, i) => [
      `x${i}`,
      (chunks: Array<ReactNode>) => cloneElement(element, { key: i, children: undefined }, ...chunks),
    ])
  );
  const outcome = intl[FORMAT]<ReactNode>(message, { ...values, ...tags });

  return outcome._tag === "NotExtracted" ? <>{children}</> : <>{outcome.value}</>;
}

/** Where `toNodes` collects a message's arguments. */
type ArgSink = {
  /** Receives each `<Val>`/`<Plural>`/`<Select>` value by argument name. */
  readonly values: Record<string, MessageValue>;
  /** Arguments recorded so far, for the shared slot rules. */
  readonly seen: Map<string, MessageValue>;
  /** Receives each argument the slot rules reject. */
  readonly problems: Array<ArgProblem>;
};

/**
 * Turn `<T>` children into message parts, collecting argument values and the elements behind positional tags.
 *
 * @param children - The children to read.
 * @param args - Receives the arguments and any slot-rule problems.
 * @param elements - Receives each element, in tag order.
 * @returns The message parts.
 * @throws On a child `<T>` cannot represent (see `renderT`).
 */
function toNodes(
  children: ReactNode,
  args: ArgSink,
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
      nodes.push(...toNodes(child, args, elements));
      continue;
    }

    if (!isValidElement<ElementProps>(child)) {
      throw new Error(
        `<T> child is not text, an element, <Val>, <Plural> or <Select>: ${Object.prototype.toString.call(child)}`
      );
    }

    if (child.type === Fragment) {
      nodes.push(...toNodes(child.props.children, args, elements));
      continue;
    }

    nodes.push(toElementNode(child, args, elements));
  }

  return nodes;
}

function toElementNode(
  element: ReactElement<ElementProps>,
  args: ArgSink,
  elements: Array<ReactElement<ElementProps>>
): MessageNode {
  const { props } = element;

  if (element.type === Val) {
    const [name, value] = singleArg(element, "Val");
    addArg(args, name, value);

    return { kind: "arg", name };
  }

  if (element.type === Plural) {
    const [name, value] = singleArg(element, "Plural");
    addArg(args, name, value);
    const forms = Object.fromEntries(
      propEntries(element).flatMap(([key, form]) => {
        if (!isPluralForm(key)) {
          return [];
        }

        if (typeof form !== "string") {
          throw new TypeError(`<Plural ${key}> needs a string literal form`);
        }

        return [[key, form]];
      })
    );

    return { kind: "plural", name, forms };
  }

  if (element.type === Select) {
    const [name, value] = singleArg(element, "Select");
    addArg(args, name, value);

    return selectNode(element, name);
  }

  const index = elements.push(element) - 1;

  return { kind: "el", index, children: toNodes(props.children, args, elements) };
}

// The extractor rejects each throw's case, so reaching one is a defect.
function selectNode(element: ReactElement<ElementProps>, name: string): MessageNode {
  const cases: Array<readonly [string, string]> = [];
  let other: string | undefined;
  for (const [key, text] of propEntries(element)) {
    const prop = selectProp(key);

    if (prop._tag === "NotBranch") {
      continue;
    }

    if (prop._tag === "InvalidCase") {
      throw new Error(describeInvalidCase(key));
    }

    if (typeof text !== "string") {
      throw new TypeError(`<Select ${key}> needs a string literal branch`);
    }

    if (prop._tag === "Other") {
      other = text;
    } else {
      cases.push([prop.key, text]);
    }
  }

  if (other === undefined) {
    throw new Error("<Select> needs an `other` branch");
  }

  return { kind: "select", name, cases, other };
}

function addArg(args: ArgSink, name: string, value: MessageValue): void {
  const problem = recordArg(args.seen, name, value);

  if (problem) {
    args.problems.push(problem);
  } else {
    args.values[name] = value;
  }
}

// Branch names (one, other, _0, _company…) are reserved only on <Plural>/<Select>; <Val one={1} /> is a value named "one".
function singleArg(
  element: ReactElement<ElementProps>,
  component: "Val" | "Plural" | "Select"
): [string, MessageValue] {
  const entries = propEntries(element).filter(([key]) => key !== "children" && !isBranch(component, key));
  const [entry] = entries;

  if (entries.length !== 1 || entry === undefined) {
    const names = entries.map(([key]) => key).join(", ") || "none";
    throw new Error(`<${component}> needs exactly one value prop, got ${names}`);
  }

  const [name, value] = entry;

  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError(`<${component} ${name}> needs a string or number value`);
  }

  return [name, value];
}

function isBranch(component: "Val" | "Plural" | "Select", key: string): boolean {
  switch (component) {
    case "Val":
      return false;
    case "Plural":
      return isPluralForm(key);
    case "Select":
      return selectProp(key)._tag !== "NotBranch";
  }
}

// Element props have no static type at this boundary: <Val>/<Plural>/<Select> props are read and checked here.
function propEntries(element: ReactElement<ElementProps>): Array<[string, unknown]> {
  return Object.entries(element.props);
}
