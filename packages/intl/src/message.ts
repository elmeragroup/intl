// Message identity: the one serializer shared by the runtime (<T>) and the extractor, so both derive the same key.

/** A parsed message part. The runtime builds these from React children, the extractor from compiled JSX. */
export type MessageNode =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "arg"; readonly name: string }
  | { readonly kind: "el"; readonly index: number; readonly children: ReadonlyArray<MessageNode> }
  | { readonly kind: "plural"; readonly name: string; readonly forms: Readonly<Record<string, string>> }
  | {
      readonly kind: "select";
      readonly name: string;
      /** Case key and text, in written order (a record would move integer-like keys first). */
      readonly cases: ReadonlyArray<readonly [string, string]>;
      readonly other: string;
    };

/**
 * Version of the serializer's output format. Catalogs record it in their `X-Elmera-Serializer` header, and `check`
 * fails on a mismatch, because a serializer change re-keys messages. Bump it with any change to `serialize` or
 * `hashKey`.
 */
export const SERIALIZER_VERSION = "1";

const PLURAL_CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);
const EXACT_PLURAL_FORM = /^_\d+$/u;
const SYNTAX_CHAR = /[{}<>]/u;
const QUOTE_RUN_CHAR = /[{}<>']/u;
const QUOTE_OPENER = /['{}<>#|]/u;

/**
 * Whether a `<Plural>` prop name is a plural form: a CLDR category, or `_<n>` for an exact match (`_0` is `=0`).
 *
 * @param name - The prop name.
 * @returns `true` for a plural form name.
 */
export function isPluralForm(name: string): boolean {
  return PLURAL_CATEGORIES.has(name) || EXACT_PLURAL_FORM.test(name);
}

// A select key is what intl-messageformat's parser reads as one (its identifier regex): no white space or pattern
// syntax. Kept byte for byte, unnormalized: a decomposed `é` is its own key, as in ICU.
const SELECT_CASE = /^_([^\p{White_Space}\p{Pattern_Syntax}]+)$/u;

/** What a `<Select>` prop name is: its `other` branch, a case (`_company` is the case `company`), or neither. */
export type SelectProp =
  | { readonly _tag: "Other" }
  | { readonly _tag: "Case"; readonly key: string }
  | { readonly _tag: "InvalidCase"; readonly name: string }
  | { readonly _tag: "NotBranch" };

/**
 * Read a `<Select>` prop name. Branch names start with `_`, so any case key (`_value`, `_1`) stays apart from the one
 * value prop, whose name is the ICU argument.
 *
 * @param name - The prop name.
 * @returns The prop's role; `InvalidCase` for a `_` name that is no ICU select key, or that spells `other`.
 */
export function selectProp(name: string): SelectProp {
  if (name === "other") {
    return { _tag: "Other" };
  }

  if (!name.startsWith("_")) {
    return { _tag: "NotBranch" };
  }

  const key = SELECT_CASE.exec(name)?.[1];

  return key === undefined || key === "other" ? { _tag: "InvalidCase", name } : { _tag: "Case", key };
}

/**
 * Describe a `<Select>` branch name that is no ICU select key, with its fix.
 *
 * @param name - The prop name.
 * @returns A message naming the fix.
 */
export function describeInvalidCase(name: string): string {
  return name === "_other"
    ? "<Select> branch `_other` duplicates `other`; write `other`"
    : `<Select> branch \`${name}\` is no select key; use \`_\` and a key without white space or ICU syntax`;
}

// Positional tags are `x<n>`, and <T> passes args and tag renderers in one values object, so an arg named like a
// tag would overwrite (or be overwritten by) a tag renderer.
const RESERVED_ARG = /^x\d+$/u;

/** Why a `<Val>`/`<Plural>`/`<Select>` argument cannot be part of a `<T>` message. */
export type ArgProblem =
  | { readonly _tag: "ReservedArgName"; readonly name: string }
  | { readonly _tag: "ConflictingArg"; readonly name: string };

/**
 * Record one `<Val>`/`<Plural>`/`<Select>` argument of a `<T>` message: the slot rules the extractor and the runtime share. A
 * name may repeat only with the same value, because the message has one value per name.
 *
 * @template V - What identifies a value: its expression text in the extractor, the value itself at runtime.
 * @param seen - The arguments recorded so far in this `<T>`; receives this one.
 * @param name - The argument name.
 * @param value - The argument's value.
 * @returns Why the argument is not allowed, or `undefined`.
 */
export function recordArg<V>(seen: Map<string, V>, name: string, value: V): ArgProblem | undefined {
  if (RESERVED_ARG.test(name)) {
    return { _tag: "ReservedArgName", name };
  }

  if (seen.has(name) && !Object.is(seen.get(name), value)) {
    return { _tag: "ConflictingArg", name };
  }

  seen.set(name, value);

  return undefined;
}

/**
 * Describe an argument problem with its fix.
 *
 * @param problem - The problem.
 * @returns A message naming the fix.
 */
export function describeArgProblem(problem: ArgProblem): string {
  switch (problem._tag) {
    case "ReservedArgName":
      return `argument name \`${problem.name}\` is reserved for positional tags (x0, x1, …) in <T>; rename it`;
    case "ConflictingArg":
      return `argument \`${problem.name}\` has two values in one <T>; give each value its own name`;
  }
}

/**
 * Serialize message parts to the ICU source that keys the message: whitespace runs collapse to one space, the
 * ends are trimmed, elements become positional tags (`<x0>`), and literal ICU syntax is quoted.
 *
 * @param nodes - The message parts in source order.
 * @returns The ICU message source.
 */
export function serialize(nodes: ReadonlyArray<MessageNode>): string {
  return emit(trimEnds(normalize(nodes)), "");
}

/**
 * The catalog key of a message: its source, prefixed by its context and `\u0004` (the gettext separator) when it
 * has one. An empty context is no context.
 *
 * @param source - The serialized ICU source.
 * @param context - The disambiguating context.
 * @returns The catalog key.
 */
export function keyOf(source: string, context: string | undefined): string {
  return context === undefined || context === "" ? source : `${context}\u0004${source}`;
}

// Seven base-36 characters: 36^7 ≈ 7.8e10 keys. By the birthday bound, n keys collide with probability about
// n² / (2 · 36^7): 4e-5 for the first adopting app's 2,502 keys, 6e-4 for 10,000. A collision is not silent: `compileCatalog`
// and `check` fail on it, and a context on either message (or a reworded source) resolves it.
const HASH_LENGTH = 7;
const HASH_SPACE = 36 ** HASH_LENGTH;
const hashes = new Map<string, string>();

/**
 * The wire key of a catalog entry: `keyOf(source, context)` hashed to seven base-36 characters. A compiled catalog is
 * keyed by it, so the browser receives short keys instead of English sources. The compiler and the runtime both call
 * this one function, so they cannot drift; any change to it re-keys every compiled catalog and bumps
 * `SERIALIZER_VERSION`.
 *
 * cyrb53 (a public-domain, non-cryptographic 53-bit string hash; bryc, 2018), reduced mod 36^7. Collisions are
 * acceptable because they fail the build, never a render.
 *
 * @param key - `keyOf(source, context)`.
 * @returns The hashed key, memoized per string for the process (bounded by the messages that render).
 */
export function hashKey(key: string): string {
  const cached = hashes.get(key);

  if (cached !== undefined) {
    return cached;
  }

  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- cyrb53 hashes UTF-16 code units; code points would change every wire key
    const code = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = (4294967296 * (2097151 & h2) + (h1 >>> 0)) % HASH_SPACE;
  const text = hash.toString(36).padStart(HASH_LENGTH, "0");
  hashes.set(key, text);

  return text;
}

type MutableText = { kind: "text"; text: string };
type Normalized = MutableText | Exclude<MessageNode, { kind: "text" }>;

// Whitespace is normalized here, not by JSX compilers, so every compiler yields the same key.
function normalize(nodes: ReadonlyArray<MessageNode>): Array<Normalized> {
  const merged: Array<Normalized> = [];
  for (const node of nodes) {
    const last = merged.at(-1);

    if (node.kind === "text" && last?.kind === "text") {
      last.text += node.text;
    } else if (node.kind === "text") {
      merged.push({ kind: "text", text: node.text });
    } else if (node.kind === "el") {
      merged.push({ ...node, children: normalize(node.children) });
    } else {
      merged.push(node);
    }
  }
  for (const node of merged) {
    if (node.kind === "text") {
      node.text = node.text.replaceAll(/[ \t\n\r]+/gu, " ");
    }
  }

  return merged.filter((node) => node.kind !== "text" || node.text !== "");
}

function trimEnds(nodes: Array<Normalized>): Array<Normalized> {
  const first = nodes[0];
  const last = nodes.at(-1);

  if (first?.kind === "text") {
    first.text = first.text.replace(/^[ \t\n\r]+/u, "");
  }

  if (last?.kind === "text") {
    last.text = last.text.replace(/[ \t\n\r]+$/u, "");
  }

  return nodes.filter((node) => node.kind !== "text" || node.text !== "");
}

function firstChar(node: MessageNode | undefined): string {
  if (node === undefined) {
    return "";
  }

  if (node.kind === "text") {
    return node.text.charAt(0);
  }

  return node.kind === "el" ? "<" : "{";
}

// ICU apostrophe mode, verified exhaustively by test/serializer-fuzz.test.ts:
// - a run that starts with a syntax char ({}<>) is quoted whole, its apostrophes doubled;
// - any other apostrophe is doubled only when the next char could open or continue a quote, so "Don't" stays readable.
function escapeText(text: string, next: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text.charAt(i);

    if (SYNTAX_CHAR.test(char)) {
      let run = char;
      while (i + 1 < text.length && QUOTE_RUN_CHAR.test(text.charAt(i + 1))) {
        i += 1;
        run += text.charAt(i);
      }
      out += `'${run.replaceAll("'", "''")}'`;
    } else if (char === "'") {
      const following = i + 1 < text.length ? text.charAt(i + 1) : next;
      out += QUOTE_OPENER.test(following) ? "''" : "'";
    } else {
      out += char;
    }

    i += 1;
  }

  return out;
}

// A plural form is literal text where only `#` (the count) is special: each run between `#`s is escaped like <T>
// text, followed by the `#` or the form's closing brace.
function escapeForm(form: string): string {
  const runs = form.split("#");

  return runs.map((run, i) => escapeText(run, i + 1 < runs.length ? "#" : "}")).join("#");
}

// Exact forms (`_0` -> `=0`) first, then categories in a fixed order, so prop order never changes the key.
function compareForms(a: string, b: string): number {
  const exactFirst = Number(b.startsWith("_")) - Number(a.startsWith("_"));

  return exactFirst || a.localeCompare(b, "en", { numeric: true });
}

// `after` is the char that follows this node list: "<" inside a tag, whose closing tag comes next.
function emit(nodes: ReadonlyArray<MessageNode>, after: string): string {
  return nodes
    .map((node, i) => {
      switch (node.kind) {
        case "text":
          return escapeText(node.text, i + 1 < nodes.length ? firstChar(nodes[i + 1]) : after);
        case "arg":
          return `{${node.name}}`;
        case "el":
          return `<x${node.index}>${emit(node.children, "<")}</x${node.index}>`;
        case "plural": {
          const forms = Object.entries(node.forms)
            .toSorted(([a], [b]) => compareForms(a, b))
            .map(
              ([form, text]) => `${form.startsWith("_") ? `=${form.slice(1)}` : form} {${escapeForm(text)}}`
            );

          return `{${node.name}, plural, ${forms.join(" ")}}`;
        }
        case "select": {
          const branches = [...node.cases, ["other", node.other] as const].map(
            ([key, text]) => `${key} {${escapeText(text, "}")}}`
          );

          return `{${node.name}, select, ${branches.join(" ")}}`;
        }
        default: {
          const unhandled: never = node;

          return unhandled;
        }
      }
    })
    .join("");
}
