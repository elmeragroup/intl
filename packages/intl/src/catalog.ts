// The compiled catalog: what `compileCatalog` (intl-tools) emits and the runtime reads with no ICU parser. Entries are
// keyed by `hashKey(keyOf(source, context))`; each value is the parser's AST as compact tuples, literals as plain
// strings. The IR exists only in generated output, never in a committed file, so `CATALOG_VERSION` can change freely.
import type { MessageFormatElement } from "./icu";

/**
 * The locale sources are written in. Its catalog compiles the msgids, and an entry compiled from the source for want
 * of a translation formats in it.
 */
export const SOURCE_LOCALE = "en";

/** Version of the catalog shape and its IR. The runtime rejects a catalog of another version. */
export const CATALOG_VERSION = 1;

// The parser's element types (TYPE in @formatjs/icu-messageformat-parser, which intl-messageformat does not
// re-export); the IR reuses them as tuple tags. `#` is the bare 0, and an ordinal plural gets its own tag.
const LITERAL = 0;
const ARGUMENT = 1;
const NUMBER = 2;
const DATE = 3;
const TIME = 4;
const SELECT = 5;
const PLURAL = 6;
const POUND = 7;
const TAG = 8;
const ORDINAL = 9;

type Element<T extends MessageFormatElement["type"]> = Extract<MessageFormatElement, { type: T }>;
type NumberStyle = NonNullable<Element<typeof NUMBER>["style"]>;
type DateTimeStyle = NonNullable<Element<typeof DATE>["style"]>;

/** A plural's or select's arms, by key (`one`, `=0`, `other`, a select value). */
export type IrOptions = Readonly<Record<string, IrNodes>>;

/** One message node. A number's or date's style is the parser's: a named style, or its parsed skeleton. */
export type IrNode =
  | string
  | 0
  | readonly [typeof ARGUMENT, string]
  | readonly [typeof NUMBER, string]
  | readonly [typeof NUMBER, string, NumberStyle]
  | readonly [typeof DATE | typeof TIME, string]
  | readonly [typeof DATE | typeof TIME, string, DateTimeStyle]
  | readonly [typeof SELECT, string, IrOptions]
  | readonly [typeof PLURAL | typeof ORDINAL, string, IrOptions]
  | readonly [typeof PLURAL | typeof ORDINAL, string, IrOptions, number]
  | readonly [typeof TAG, string, IrNodes];

/** A node list: a lone literal as a plain string, otherwise the nodes. */
export type IrNodes = string | ReadonlyArray<IrNode>;

declare const COMPILED: unique symbol;

/**
 * A locale's compiled catalog. Only `compileCatalog` from `@elmeragroup/intl-tools` makes one (through a `*.po` import,
 * `loadCatalog` or `compileCatalog` itself), so a raw PO or a JSON object of translations cannot be passed where a
 * catalog is expected. Plain JSON at runtime: the brand is type-only, so the catalog crosses Flight and loader data.
 */
export type Catalog = {
  /** `CATALOG_VERSION` of the compiler that made it, which may be another package version's. */
  readonly v: number;
  /** Entries by hashed key. An entry whose message is its own source text is left out (see `isLiteralSource`). */
  readonly m: Readonly<Record<string, IrNodes>>;
  /** Hashed keys of entries compiled from the English source for want of a translation; they format in `en`. */
  readonly e?: ReadonlyArray<string>;
  readonly [COMPILED]: true;
};

/**
 * Make a catalog from compiled entries. For `compileCatalog` only: the entries must be its validated output.
 *
 * @param entries - IR by hashed key.
 * @param english - Hashed keys of the entries compiled from the English source.
 * @returns The catalog.
 */
export function makeCatalog(
  entries: ReadonlyArray<readonly [string, IrNodes]>,
  english: ReadonlyArray<string>
): Catalog {
  const catalog: Omit<Catalog, typeof COMPILED> =
    english.length === 0
      ? { v: CATALOG_VERSION, m: Object.fromEntries(entries) }
      : { v: CATALOG_VERSION, m: Object.fromEntries(entries), e: english };

  // SAFETY: Catalog's brand is a declared-only symbol, so no runtime value carries it. compileCatalog is this
  // function's only caller, after decoding each entry back to its parsed AST and dry-formatting it.
  return catalog as Catalog;
}

/**
 * Whether a source formats to its own text: it holds no ICU syntax and no apostrophe (an apostrophe may quote).
 * The compiler leaves such an entry out, and the runtime renders a missing key's source as is only when this holds,
 * so the two share this one predicate.
 *
 * @param source - The English ICU source.
 * @returns `true` when the source is its own rendering.
 */
export function isLiteralSource(source: string): boolean {
  return !/[{}<>']/.test(source);
}

/**
 * Encode a parsed AST as IR.
 *
 * @param ast - The parser's AST.
 * @returns The IR.
 */
export function encodeAst(ast: ReadonlyArray<MessageFormatElement>): IrNodes {
  const [first] = ast;

  if (ast.length === 1 && first?.type === LITERAL) {
    return first.value;
  }

  return ast.map(encodeNode);
}

function encodeOptions(options: Element<typeof SELECT>["options"]): IrOptions {
  return Object.fromEntries(Object.entries(options).map(([key, option]) => [key, encodeAst(option.value)]));
}

function encodeNode(element: MessageFormatElement): IrNode {
  switch (element.type) {
    case LITERAL:
      return element.value;
    case ARGUMENT:
      return [ARGUMENT, element.value];
    case NUMBER:
      return element.style === null || element.style === undefined
        ? [NUMBER, element.value]
        : [NUMBER, element.value, element.style];
    case DATE:
    case TIME:
      return element.style === null || element.style === undefined
        ? [element.type, element.value]
        : [element.type, element.value, element.style];
    case SELECT:
      return [SELECT, element.value, encodeOptions(element.options)];
    case PLURAL: {
      const tag = element.pluralType === "ordinal" ? ORDINAL : PLURAL;
      const options = encodeOptions(element.options);

      return element.offset === 0
        ? [tag, element.value, options]
        : [tag, element.value, options, element.offset];
    }
    case POUND:
      return 0;
    case TAG:
      return [TAG, element.value, encodeAst(element.children)];
    default: {
      const unhandled: never = element;

      return unhandled;
    }
  }
}

/**
 * Decode IR into the parser's AST, as the formatter takes it.
 *
 * @param nodes - The IR.
 * @returns The AST.
 */
export function decodeAst(nodes: IrNodes): Array<MessageFormatElement> {
  return typeof nodes === "string" ? [{ type: LITERAL, value: nodes }] : nodes.map(decodeNode);
}

function decodeOptions(options: IrOptions): Element<typeof SELECT>["options"] {
  return Object.fromEntries(
    Object.entries(options).map(([key, nodes]) => [key, { value: decodeAst(nodes) }])
  );
}

function decodeNode(node: IrNode): MessageFormatElement {
  if (typeof node === "string") {
    return { type: LITERAL, value: node };
  }

  if (node === 0) {
    return { type: POUND };
  }

  switch (node[0]) {
    case ARGUMENT:
      return { type: ARGUMENT, value: node[1] };
    case NUMBER:
      return { type: NUMBER, value: node[1], style: node[2] ?? null };
    case DATE:
    case TIME:
      return { type: node[0], value: node[1], style: node[2] ?? null };
    case SELECT:
      return { type: SELECT, value: node[1], options: decodeOptions(node[2]) };
    case PLURAL:
    case ORDINAL:
      return {
        type: PLURAL,
        value: node[1],
        options: decodeOptions(node[2]),
        offset: node[3] ?? 0,
        pluralType: node[0] === ORDINAL ? "ordinal" : "cardinal",
      };
    case TAG:
      return { type: TAG, value: node[1], children: decodeAst(node[2]) };
  }
}

/** The custom HMR event the Vite plugin sends when a `.po` changes in dev; `/start`'s catalog reload listens. */
export const CATALOG_UPDATE_EVENT = "elmera-intl:catalog";
