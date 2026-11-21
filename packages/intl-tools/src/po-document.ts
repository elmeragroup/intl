// A PO file as the PO text format holds it: the header's fields and each message with its comments, nothing derived.
// po-text.ts reads and writes it; po.ts projects it onto the catalog entries the tools use.
import * as Schema from "effect/Schema";

/** A `#:` reference: the file that uses a message, and the line when the reference names one. */
export const PoReference = /* @__PURE__ */ Schema.Struct({
  path: Schema.String,
  line: /* @__PURE__ */ Schema.optionalKey(Schema.Int),
});

/** One message: its keywords' strings, unescaped, and the comments that precede it. */
export const PoMessage = /* @__PURE__ */ Schema.Struct({
  /** `msgctxt`, when the message has one. */
  context: /* @__PURE__ */ Schema.optionalKey(Schema.String),
  /** `msgid`: the source. */
  id: Schema.String,
  /** `msgstr`: the translation, empty when there is none. */
  translation: Schema.String,
  references: /* @__PURE__ */ Schema.Array(PoReference),
  /** `#.` comments, in order. */
  extractedComments: /* @__PURE__ */ Schema.Array(Schema.String),
  /** The flags of every `#,` line, in order. */
  flags: /* @__PURE__ */ Schema.Array(Schema.String),
});

/** A PO file: the header's fields, when it has a header with any, and its messages in file order. */
export const PoDocument = /* @__PURE__ */ Schema.Struct({
  header: /* @__PURE__ */ Schema.optionalKey(/* @__PURE__ */ Schema.Record(Schema.String, Schema.String)),
  messages: /* @__PURE__ */ Schema.Array(PoMessage),
});
