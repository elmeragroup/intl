// po-parser 2.2.0's API over `PoText`, so its tests and recorded outputs run against our codec unchanged. The mapping
// (README.md): `msgctxt`/`msgid`/`msgstr` are `context`/`id`/`translation`; `meta` is `header`; an array or `meta`
// po-parser leaves out is an empty one here; a failure is thrown with our message, which contains po-parser's.
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { PoDocument } from "../../src/po-document.ts";
import { PoText } from "../../src/po-text.ts";

/** One message as po-parser shapes it. */
export type Entry = {
  msgctxt?: string;
  msgid: string;
  msgstr: string;
  references?: Array<{ path: string; line?: number }>;
  extractedComments?: Array<string>;
  flags?: Array<string>;
};

/** A file as po-parser shapes it. */
export type Catalog = { meta?: Record<string, string>; messages?: Array<Entry> };

const decode = Schema.decodeResult(PoText);
const encode = Schema.encodeSync(PoText);

type Document = typeof PoDocument.Type;

function catalogOf(document: Document): Catalog {
  const messages = document.messages.map((message) => {
    const entry: Entry = { msgid: message.id, msgstr: message.translation };

    if (message.context !== undefined) {
      entry.msgctxt = message.context;
    }

    if (message.references.length > 0) {
      entry.references = message.references.map((reference) => ({ ...reference }));
    }

    if (message.extractedComments.length > 0) {
      entry.extractedComments = [...message.extractedComments];
    }

    if (message.flags.length > 0) {
      entry.flags = [...message.flags];
    }

    return entry;
  });
  const catalog: Catalog = {};

  if (document.header !== undefined) {
    catalog.meta = { ...document.header };
  }

  if (messages.length > 0) {
    catalog.messages = messages;
  }

  return catalog;
}

function documentOf(catalog: Catalog): Document {
  const messages = (catalog.messages ?? []).map((entry) => {
    const message = {
      id: entry.msgid,
      translation: entry.msgstr,
      references: entry.references ?? [],
      extractedComments: entry.extractedComments ?? [],
      flags: entry.flags ?? [],
    };

    return entry.msgctxt === undefined ? message : { ...message, context: entry.msgctxt };
  });

  return catalog.meta === undefined ? { messages } : { header: catalog.meta, messages };
}

/**
 * Decode PO text and shape it as po-parser does.
 *
 * @param content - PO text.
 * @returns The catalog.
 * @throws The codec's failure, as po-parser throws.
 */
function parse(content: string): Catalog {
  const decoded = decode(content);

  if (Result.isFailure(decoded)) {
    throw new Error(decoded.failure.message);
  }

  return catalogOf(decoded.success);
}

/**
 * Encode a catalog shaped as po-parser shapes it.
 *
 * @param catalog - The catalog.
 * @returns PO text.
 */
function serialize(catalog: Catalog): string {
  return encode(documentOf(catalog));
}

/** po-parser's default export, over `PoText`. */
const POParser = { parse, serialize };

export default POParser;
