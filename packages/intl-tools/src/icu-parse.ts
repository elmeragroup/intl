// The ICU parser, build-time only: `compileCatalog` and `check` parse here, and the runtime formats what they emit
// with no parser of its own.
import { IntlMessageFormat } from "intl-messageformat";

import type { MessageFormatElement } from "@elmeragroup/intl/internal/icu";

/** A message that does not parse as ICU. */
export type IcuSyntaxError = { readonly _tag: "IcuSyntaxError"; readonly reason: string };

/**
 * Parse an ICU message, keeping its argument names as written.
 *
 * @param message - The ICU message.
 * @param locale - The locale it is written in (a `j` date skeleton's hour cycle depends on it).
 * @returns The message's AST, or why it does not parse.
 */
export function parseIcu(
  message: string,
  locale: string
): { readonly _tag: "Parsed"; readonly ast: Array<MessageFormatElement> } | IcuSyntaxError {
  try {
    return { _tag: "Parsed", ast: new IntlMessageFormat(message, locale).getAst() };
  } catch (error) {
    return { _tag: "IcuSyntaxError", reason: error instanceof Error ? error.message : String(error) };
  }
}
