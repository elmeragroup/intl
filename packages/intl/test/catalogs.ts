// Catalogs for the tests, from intl-tools' compileCatalog (the compiler every loader runs), shipped through JSON as a
// browser receives them. A test lists each message by its English source, with its translation or "" for none.

import { compileCatalog } from "#compile";

import type { Catalog, Formats } from "@elmeragroup/intl/core";
import { keyOf } from "@elmeragroup/intl/internal/message";

/** Messages by `keyOf(source, context)`: each one's translation, or "" for an untranslated (English) entry. */
export type Messages = Readonly<Record<string, string>>;

/**
 * Compile messages into a locale's catalog.
 *
 * @param locale - The locale (`en` compiles every source).
 * @param messages - Translations by key.
 * @param formats - The app's formats, which the compiler's dry-format resolves.
 * @returns The catalog after a JSON round trip.
 * @throws When the messages do not compile: the test's own input is broken.
 */
export function compiled(locale: string, messages: Messages, formats?: Formats): Catalog {
  const result = compileCatalog(poOf(messages), locale, { formats });

  if (result._tag !== "Compiled") {
    throw result;
  }

  const shipped: unknown = JSON.parse(JSON.stringify(result.catalog));

  // SAFETY: a compiled catalog's JSON round trip, which is the shape every catalog reaches the runtime in.
  return shipped as Catalog;
}

/**
 * The English catalog of some sources: what `<IntlProvider>` gets in `en` (a `?source` import in an app).
 *
 * @param sources - The English sources.
 * @returns The catalog.
 */
export function english(...sources: ReadonlyArray<string>): Catalog {
  return compiled("en", Object.fromEntries(sources.map((source) => [source, ""])));
}

/** The key of a source with a context, for `Messages`. */
export const withContext = (context: string, source: string): string => keyOf(source, context);

function poOf(messages: Messages): string {
  const entries = Object.entries(messages).map(([key, translation]) => {
    const separator = key.indexOf("\u0004");
    const context = separator === -1 ? "" : `msgctxt ${JSON.stringify(key.slice(0, separator))}\n`;

    return `${context}msgid ${JSON.stringify(key.slice(separator + 1))}\nmsgstr ${JSON.stringify(translation)}\n`;
  });

  return [`msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=utf-8\\n"\n`, ...entries].join("\n");
}
