import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { expect, it } from "vitest";

import { PoDocument } from "../src/po-document.ts";
import { PoText } from "../src/po-text.ts";

// The documents PO text writes on one line each and reads back as written. Outside them a value changes on the way:
// a `#:` path loses its spaces at the ends and splits at `:`, a comment or flag is trimmed and split at `,`, an empty
// msgctxt is not written, a header field is `Key: value` with the value trimmed, an empty header or a first message
// with an empty msgid and msgstr is the header, and a reference line of 0 is no line.
const OneLine = /^[^\n]*$/u;
const Path = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isTrimmed(),
  Schema.isPattern(OneLine),
  Schema.isPattern(/^[^:]*$/u)
);
const Comment = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed(), Schema.isPattern(OneLine));
const Flag = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed(), Schema.isPattern(/^[^,\n]*$/u));
const CanonicalDocument = Schema.Struct({
  header: Schema.optionalKey(
    Schema.Record(
      Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9-]*$/u)),
      Schema.String.check(Schema.isTrimmed())
    ).check(Schema.isMinProperties(1))
  ),
  messages: Schema.Array(
    Schema.Struct({
      context: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
      id: Schema.String.check(Schema.isNonEmpty()),
      translation: Schema.String,
      references: Schema.Array(
        Schema.Struct({
          path: Path,
          line: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1e6 }))),
        })
      ),
      extractedComments: Schema.Array(Comment),
      flags: Schema.Array(Flag),
    })
  ),
});

const decode = Schema.decodeResult(PoText);
const encode = Schema.encodeSync(PoText);
// Structural equality as the document schema defines it, independent of the codec.
const equivalent = Schema.toEquivalence(PoDocument);
const RUNS = 500;

// Unit under test: the PoText codec. Oracle: the generated document itself: written and read back, it must come back
// unchanged, escapes, unicode and every comment kind included.
it("reads back every document it writes", async () => {
  const result = await Effect.runPromise(
    Arbitrary.checkEffect(
      Arbitrary.schema(CanonicalDocument),
      (document) => {
        const decoded = decode(encode(document));

        return Result.isSuccess(decoded) && equivalent(decoded.success, document);
      },
      { runs: RUNS }
    )
  );

  expect([result._tag, Arbitrary.formatCheckFailure(result)]).toEqual(["Passed", undefined]);
  expect(result._tag === "Passed" ? result.runs : 0).toBe(RUNS);
});
