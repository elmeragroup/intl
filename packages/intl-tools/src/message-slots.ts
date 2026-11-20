// The slots of an ICU message a translation must keep: argument names, the kind of value each takes, and tags.
import type { MessageFormatElement } from "@elmeragroup/intl/internal/icu";

import type { IcuSyntaxError } from "./icu-parse";
import { parseIcu } from "./icu-parse";

/**
 * How a message uses an argument: plain `{x}`, `{x, select}`, a number (number, plural, selectordinal) or a date
 * (date, time). A source's uses fix the value's type, and a translation may use the argument only in a way that
 * value renders correctly (see `isCompatibleUse`).
 */
export type ArgKind = "plain" | "select" | "number" | "date";

/** Argument names, the kinds each is used as, and tag names of a message. */
export type MessageSlots = {
  /** Argument names, sorted. */
  readonly args: ReadonlyArray<string>;
  /** Per argument, every kind the message uses it as. */
  readonly kinds: ReadonlyMap<string, ReadonlySet<ArgKind>>;
  /** Tag names, sorted. */
  readonly tags: ReadonlyArray<string>;
};

// TYPE in @formatjs/icu-messageformat-parser, which intl-messageformat does not re-export. Literal (0), pound (7)
// and tag (8) are not arguments.
const KIND_BY_TYPE: ReadonlyMap<number, ArgKind> = new Map([
  [1, "plain"], // argument
  [2, "number"], // number
  [3, "date"], // date
  [4, "date"], // time
  [5, "select"], // select
  [6, "number"], // plural and selectordinal
]);

/**
 * Compile a message and read its shape.
 *
 * @param message - The ICU message.
 * @param locale - The locale it is written in.
 * @returns Its arguments (with kinds) and tag names, or why it does not compile.
 */
export function messageSlots(
  message: string,
  locale: string
): { readonly _tag: "Slots"; readonly slots: MessageSlots } | IcuSyntaxError {
  const parsed = parseIcu(message, locale);

  if (parsed._tag === "IcuSyntaxError") {
    return parsed;
  }

  const { ast } = parsed;
  const kinds = new Map<string, Set<ArgKind>>();
  const tags: Array<string> = [];
  const walk = (elements: ReadonlyArray<MessageFormatElement>): void => {
    for (const element of elements) {
      if ("children" in element) {
        tags.push(element.value);
        walk(element.children);
        continue;
      }

      const kind = KIND_BY_TYPE.get(element.type);

      if (kind !== undefined && "value" in element) {
        kinds.set(element.value, (kinds.get(element.value) ?? new Set<ArgKind>()).add(kind));
      }

      if ("options" in element) {
        Object.values(element.options).forEach((option) => walk(option.value));
      }
    }
  };
  walk(ast);

  return { _tag: "Slots", slots: { args: [...kinds.keys()].toSorted(), kinds, tags: tags.toSorted() } };
}

// The value each kind renders: plain `{x}` and select take text.
const VALUE_BY_KIND = {
  plain: "text",
  select: "text",
  number: "number",
  date: "date",
} as const satisfies Record<ArgKind, string>;

/**
 * The arguments a message uses as more than one kind of value (text, number, date), such as `{n}` in one branch and
 * `{n, number}` in another. No single value renders in every use, so the message is uncallable.
 *
 * @param slots - The message's slots.
 * @returns Each such argument with its kinds.
 */
export function kindConflicts(
  slots: MessageSlots
): Array<{ readonly name: string; readonly kinds: ReadonlyArray<ArgKind> }> {
  return [...slots.kinds].flatMap(([name, kinds]) =>
    new Set([...kinds].map((kind) => VALUE_BY_KIND[kind])).size > 1 ? [{ name, kinds: [...kinds] }] : []
  );
}

/**
 * Whether a translation may use an argument as `used`, given the source's uses. Plain `{x}` and select take text
 * only, as the typed values do: a number or date shown plainly fails at runtime, and text formatted as a number
 * renders NaN.
 *
 * @param source - Every way the source uses the argument.
 * @param used - One way the translation uses it.
 * @returns `true` when the value the source implies renders correctly in that use.
 */
export function isCompatibleUse(source: ReadonlySet<ArgKind>, used: ArgKind): boolean {
  switch (used) {
    case "plain":
    case "select":
      return source.has("plain") || source.has("select");
    case "number":
      return source.has("number");
    case "date":
      return source.has("date");
  }
}

/**
 * The arguments a translation uses in a way its source's value cannot render.
 *
 * @param source - The source's slots.
 * @param translation - The translation's slots.
 * @returns Each mismatched argument with the translation's and the source's kinds.
 */
export function kindMismatches(
  source: MessageSlots,
  translation: MessageSlots
): Array<{ readonly name: string; readonly used: ArgKind; readonly expected: ReadonlyArray<ArgKind> }> {
  return [...translation.kinds].flatMap(([name, used]) => {
    const expected = source.kinds.get(name);

    if (expected === undefined) {
      return [];
    }

    return [...used].flatMap((kind) =>
      isCompatibleUse(expected, kind) ? [] : [{ name, used: kind, expected: [...expected] }]
    );
  });
}
