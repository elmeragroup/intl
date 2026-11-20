// The only module that imports intl-messageformat. tsdown.config.ts bundles it as `/internal/formatter` with the parser
// resolved to no-parser.js, so the runtime formats compiled ASTs and cannot parse; intl-tools parses with its own copy.
export { IntlMessageFormat, MissingValueError } from "intl-messageformat";
export type { FormatXMLElementFn, Formats as MessageFormatStyles, Formatters } from "intl-messageformat";
