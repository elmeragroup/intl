// Message reading for the extractor: the message of a compiled `<T>` element or a `msg()` call, and the literal
// helpers both read with. The walk (extract.ts) owns binding resolution and hands it in as a MessageReader.
import type {
  ArrayExpression,
  CallExpression,
  Expression,
  Node,
  ObjectExpression,
  ObjectProperty,
} from "oxc-parser";

import type { MessageNode } from "@elmeragroup/intl/internal/message";
import {
  describeArgProblem,
  describeInvalidCase,
  isPluralForm,
  recordArg,
  selectProp,
  serialize,
} from "@elmeragroup/intl/internal/message";

/** A property key resolved to its name, or a computed key the extractor cannot read. */
export type StaticName = { readonly _tag: "Static"; readonly name: string } | { readonly _tag: "Unresolved" };

/** Resolves an expression to the string it statically is (a literal, or a const bound to one), from one scope. */
export type StaticValueOf = (node: Node) => string | undefined;

/** What message reading needs from the walk at the node being read. */
export type MessageReader = {
  /** Report a failure at a node. */
  readonly fail: (node: Node, message: string) => void;
  /** Record a message. */
  readonly push: (source: string, context: string | undefined, tags: ReadonlyArray<string>) => void;
  /** Whether a node is a call of the JSX runtime (a compiled element other than a fragment call). */
  readonly isJsxCall: (node: Node | null | undefined) => node is CallExpression;
  /** Whether a node is this package's export `name`. */
  readonly isPackageBinding: (node: Node | null | undefined, name: string) => boolean;
  /** Whether an element type is React's Fragment. */
  readonly isFragment: (type: Node) => boolean;
  /** Static values in the current scope. */
  readonly staticValue: StaticValueOf;
  /** The compiled code, for comparing value expressions by text. */
  readonly code: string;
};

/**
 * Read the message of a compiled `<T>` element.
 *
 * @param reader - The walk at the call.
 * @param node - The JSX runtime call.
 * @param props - Its props argument.
 */
export function extractT(reader: MessageReader, node: CallExpression, props: Node | undefined): void {
  if (props?.type !== "ObjectExpression") {
    reader.fail(node, "<T> needs its message as children");

    return;
  }

  const read = readProps(props, reader.staticValue);

  if (read._tag === "Unreadable") {
    reader.fail(read.node, `<T> props cannot be ${read.reason}`);

    return;
  }

  const context = contextOf(reader, read.values);
  const message: MessageParts = { tags: [], args: new Map() };
  const nodes = messageNodes(reader, read.values.get("children"), message);
  reader.push(serialize(nodes), context, message.tags);
}

/**
 * Read the message of a `msg(text, options)` call.
 *
 * @param reader - The walk at the call.
 * @param node - The call.
 * @param text - Its first argument.
 * @param options - Its second argument.
 */
export function extractMsg(
  reader: MessageReader,
  node: CallExpression,
  text: Node | undefined,
  options: Node | undefined
): void {
  const read: ReadProps =
    options === undefined
      ? { _tag: "Props", values: new Map(), duplicates: new Set() }
      : options.type === "ObjectExpression"
        ? readProps(options, reader.staticValue)
        : { _tag: "Unreadable", node: options, reason: "spread" };

  if (read._tag === "Unreadable") {
    reader.fail(
      read.node,
      read.reason === "computed"
        ? "msg() options cannot use a computed key; write `context` by name"
        : "msg() options must be an object literal without spreads so the context is visible"
    );

    return;
  }

  const source = literalValue(text);

  if (source === undefined) {
    reader.fail(node, "msg() needs a string literal message");

    return;
  }

  reader.push(source, contextOf(reader, read.values), []);
}

/**
 * Normalize a property key: `t`, "t", ["t"], [`t`] and [k] with `const k = "t"` are the same key; any other computed
 * key is unresolved, never "unrelated".
 *
 * @param property - An object literal or pattern property.
 * @param valueOf - Static values in the property's scope.
 * @returns The key's name, or `Unresolved`.
 */
export function propertyKey(
  property: ObjectProperty | (Node & { readonly type: "Property" }),
  valueOf: StaticValueOf
): StaticName {
  if (!property.computed && property.key.type === "Identifier") {
    return { _tag: "Static", name: property.key.name };
  }

  const name = valueOf(property.key);

  return name === undefined ? { _tag: "Unresolved" } : { _tag: "Static", name };
}

/**
 * A string literal's value.
 *
 * @param node - Any node.
 * @returns The string, or `undefined` for anything else.
 */
export function stringValue(node: Node | null | undefined): string | undefined {
  const value = node?.type === "Literal" ? node.value : undefined;

  return typeof value === "string" ? value : undefined;
}

/**
 * A string literal or a template literal without expressions: what t(), .t() and msg() accept as a message.
 *
 * @param node - Any node.
 * @returns The text, or `undefined` for anything else.
 */
export function literalValue(node: Node | null | undefined): string | undefined {
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }

  return stringValue(node);
}

/**
 * A literal's text: string and number literals, and expression-free templates (text in compiled JSX children, and the
 * literal forms of a static key).
 *
 * @param node - Any node.
 * @returns The text, or `undefined` for anything else.
 */
export function textValue(node: Node | null | undefined): string | undefined {
  const value = node?.type === "Literal" ? node.value : undefined;

  if (typeof value === "number") {
    return String(value);
  }

  return literalValue(node);
}

// What one <T> collects while its children are read: tag descriptions and argument values by name.
type MessageParts = { readonly tags: Array<string>; readonly args: Map<string, string> };

type ReadProps =
  | {
      readonly _tag: "Props";
      /** Values by key; the last of repeated keys wins, as in JavaScript. */
      readonly values: ReadonlyMap<string, Expression>;
      readonly duplicates: ReadonlySet<string>;
    }
  | { readonly _tag: "Unreadable"; readonly node: Node; readonly reason: "spread" | "computed" };

// A present-but-dynamic context would silently change the key, so it is a failure.
function contextOf(reader: MessageReader, props: ReadonlyMap<string, Expression>): string | undefined {
  const value = props.get("context");

  if (value === undefined) {
    return undefined;
  }

  const context = stringValue(value);

  if (context === undefined) {
    reader.fail(value, "`context` must be a string literal");
  }

  return context;
}

// Message parts of compiled `<T>` children, numbering elements in pre-order as the runtime does.
function messageNodes(
  reader: MessageReader,
  children: Node | undefined,
  message: MessageParts
): Array<MessageNode> {
  if (children === undefined) {
    return [];
  }

  const list = children.type === "ArrayExpression" ? arrayElements(children) : [children];
  const nodes: Array<MessageNode> = [];
  for (const child of list) {
    const text = textValue(child);

    if (text !== undefined) {
      nodes.push({ kind: "text", text });
      continue;
    }

    if (!child || !reader.isJsxCall(child)) {
      reader.fail(child ?? children, "dynamic child in <T>; wrap values as <Val name={value} />");
      continue;
    }

    const [type, props] = child.arguments;

    if (props?.type !== "ObjectExpression" || type === undefined) {
      reader.fail(child, "dynamic child in <T>; wrap values as <Val name={value} />");
      continue;
    }

    // As a tag, its own translation would replace the outer one's text for it.
    if (reader.isPackageBinding(type, "T")) {
      reader.fail(child, "<T> cannot contain another <T>; keep the whole text in the outer <T>");
      continue;
    }

    const read = readProps(props, reader.staticValue);
    const valueComponent = VALUE_COMPONENTS.find((component) => reader.isPackageBinding(type, component));

    if (read._tag === "Unreadable") {
      reader.fail(
        read.node,
        valueComponent
          ? `<${valueComponent}> props cannot be ${read.reason}; name the value: <Val name={value} />`
          : `${read.reason} props on an element inside <T> could supply its children; write each prop out`
      );
      continue;
    }

    if (read.duplicates.has("children")) {
      reader.fail(
        child,
        "element inside <T> has both a `children` attribute and children; keep the children"
      );
      continue;
    }

    if (reader.isFragment(type)) {
      nodes.push(...messageNodes(reader, read.values.get("children"), message));
      continue;
    }

    if (valueComponent) {
      const node = valueNode(reader, valueComponent, props, read.values, message);

      if (node) {
        nodes.push(node);
      }

      continue;
    }

    const index = message.tags.length;
    const names = [...read.values.keys()].filter((name) => name !== "children");
    message.tags.push(`<x${index}> = <${[elementName(type), ...names].join(" ")}>`);
    nodes.push({ kind: "el", index, children: messageNodes(reader, read.values.get("children"), message) });
  }

  return nodes;
}

const VALUE_COMPONENTS = ["Val", "Plural", "Select"] as const;
type ValueComponent = (typeof VALUE_COMPONENTS)[number];

function valueNode(
  reader: MessageReader,
  component: ValueComponent,
  props: ObjectExpression,
  values: ReadonlyMap<string, Expression>,
  message: MessageParts
): MessageNode | undefined {
  const named = [...values.keys()].filter((name) => name !== "children" && !isBranch(component, name));
  const [name] = named;
  const value = name === undefined ? undefined : values.get(name);

  if (named.length !== 1 || name === undefined || value === undefined) {
    reader.fail(
      props,
      `<${component}> needs exactly one value prop${component === "Select" ? "; name each case `_<key>`" : ""}`
    );

    return undefined;
  }

  // One value per name: the same expression text twice is the same value; anything else may differ at runtime.
  const problem = recordArg(message.args, name, reader.code.slice(value.start, value.end));

  if (problem) {
    reader.fail(props, describeArgProblem(problem));

    return undefined;
  }

  if (component === "Val") {
    return { kind: "arg", name };
  }

  if (component === "Select") {
    return selectNode(reader, props, name, values);
  }

  const forms: Record<string, string> = {};
  for (const [form, formValue] of values) {
    if (!isPluralForm(form)) {
      continue;
    }

    const text = stringValue(formValue);

    if (text === undefined) {
      reader.fail(formValue, `<Plural> form \`${form}\` must be a string literal`);
    } else {
      forms[form] = text;
    }
  }

  return { kind: "plural", name, forms };
}

function selectNode(
  reader: MessageReader,
  props: ObjectExpression,
  name: string,
  values: ReadonlyMap<string, Expression>
): MessageNode | undefined {
  const cases: Array<readonly [string, string]> = [];
  let other: string | undefined;
  let isComplete = true;
  for (const [branch, branchValue] of values) {
    const prop = selectProp(branch);

    if (prop._tag === "NotBranch") {
      continue;
    }

    if (prop._tag === "InvalidCase") {
      reader.fail(branchValue, describeInvalidCase(branch));
      isComplete = false;
      continue;
    }

    const text = stringValue(branchValue);

    if (text === undefined) {
      reader.fail(branchValue, `<Select> branch \`${branch}\` must be a string literal`);
      isComplete = false;
    } else if (prop._tag === "Other") {
      other = text;
    } else {
      cases.push([prop.key, text]);
    }
  }

  if (!values.has("other")) {
    reader.fail(props, '<Select> needs an `other` branch: ICU requires it (`other="…"`)');

    return undefined;
  }

  return isComplete && other !== undefined ? { kind: "select", name, cases, other } : undefined;
}

// Branch names (one, other, _0, _company…) are reserved only on <Plural>/<Select>; <Val one={1} /> is a value named "one".
function isBranch(component: ValueComponent, name: string): boolean {
  switch (component) {
    case "Val":
      return false;
    case "Plural":
      return isPluralForm(name);
    case "Select":
      return selectProp(name)._tag !== "NotBranch";
  }
}

// An object literal's props, or the first part that makes them unknowable (a spread, a computed key).
function readProps(object: ObjectExpression, valueOf: StaticValueOf): ReadProps {
  const values = new Map<string, Expression>();
  const duplicates = new Set<string>();
  for (const property of object.properties) {
    if (property.type === "SpreadElement") {
      return { _tag: "Unreadable", node: property, reason: "spread" };
    }

    const key = propertyKey(property, valueOf);

    if (key._tag === "Unresolved") {
      return { _tag: "Unreadable", node: property, reason: "computed" };
    }

    if (values.has(key.name)) {
      duplicates.add(key.name);
    }

    values.set(key.name, property.value);
  }

  return { _tag: "Props", values, duplicates };
}

function elementName(type: Node): string {
  if (type.type === "Identifier") {
    return type.name;
  }

  if (type.type === "MemberExpression" && !type.computed && type.property.type === "Identifier") {
    return `${elementName(type.object)}.${type.property.name}`;
  }

  return stringValue(type) ?? "element";
}

function arrayElements(array: ArrayExpression): Array<Node | undefined> {
  return array.elements.map((element) => element ?? undefined);
}
