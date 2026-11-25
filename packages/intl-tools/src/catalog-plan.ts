// What `extract` would write, decided from what it read: each locale's PO, as read, merged with the scanned messages.
// Pure: the reads and the writes are `catalog-sync.ts`'s, so this decides the same way whatever the file system is.
import { SERIALIZER_VERSION } from "@elmeragroup/intl/internal/message";

import type { PoFile, UnusedEntries } from "./po";
import { formatPo, mergeEntries, parsePo, SERIALIZER_HEADER } from "./po";
import type { Problem } from "./problem";
import type { ProjectMessage } from "./project";

/** The fix every catalog drifted from its sources names. */
export const RUN_EXTRACT = "run `elmera-intl extract`";

/** One locale's PO as read. */
export type CatalogText = {
  readonly locale: string;
  /** The PO's absolute path, as configured. */
  readonly path: string;
  /** The path as problems show it: relative to the project root. */
  readonly shown: string;
  /** The PO's text; undefined when it does not exist. */
  readonly text: string | undefined;
};

/** A catalog file with the exact text written to it. */
export type WrittenCatalog = { readonly path: string; readonly text: string };

/** What a Catalog sync read and would write. */
export type CatalogPlan = {
  readonly problems: ReadonlyArray<Problem>;
  readonly messages: number;
  /**
   * Each distinct catalog path's text as read once (undefined: absent), by the exact path read and written (never
   * resolved: `<link>/..` leads where the kernel says, not where the string does): the snapshot the outputs to that
   * path were merged from.
   */
  readonly read: ReadonlyMap<string, string | undefined>;
  /** In the config's order of locales, each at its configured path. */
  readonly outputs: ReadonlyArray<WrittenCatalog>;
};

/** A PO as parsed: its entries (undefined when it does not exist), or the problem that it cannot be read. */
export type ParsedCatalog =
  | { readonly _tag: "Read"; readonly file: PoFile | undefined }
  | { readonly _tag: "Problem"; readonly problem: Problem };

/**
 * Parse a PO as read.
 *
 * @param catalog - The PO's text and where it is.
 * @returns Its entries, or a `CatalogUnreadable` problem naming the PO.
 */
export function parseCatalog(catalog: CatalogText): ParsedCatalog {
  if (catalog.text === undefined) {
    return { _tag: "Read", file: undefined };
  }

  const parsed = parsePo(catalog.text);

  if (parsed._tag === "PoParseError") {
    return {
      _tag: "Problem",
      problem: {
        code: "CatalogUnreadable",
        message: parsed.reason,
        fix: "keep the PO to msgctxt/msgid/msgstr with #. #: #, comments: translator comments (# ), #| and msgid_plural are not read",
        file: catalog.shown,
        locale: catalog.locale,
      },
    };
  }

  return { _tag: "Read", file: parsed.file };
}

/**
 * The problem that a catalog is keyed by another serializer: rewriting it would drop every translation whose key
 * changed.
 *
 * @param version - The serializer the catalog names.
 * @param at - The catalog and its locale.
 * @returns A `SerializerMismatch` problem naming the manual re-key.
 */
export function serializerMismatch(
  version: string,
  at: { readonly file: string; readonly locale: string }
): Problem {
  return {
    code: "SerializerMismatch",
    message: `catalog keyed by serializer ${version}, this package serializes as ${SERIALIZER_VERSION}; extract refuses to rewrite it`,
    fix: `move each msgstr to its re-keyed msgid by hand, set ${SERIALIZER_HEADER} to ${SERIALIZER_VERSION} in ${at.file}, then ${RUN_EXTRACT}`,
    ...at,
  };
}

/**
 * Merge the scanned messages into each locale's PO: every catalog `extract` would write. A plan with problems writes
 * nothing.
 *
 * @param catalogs - Each locale's PO as read, in the config's order: one snapshot per distinct path.
 * @param messages - The messages the sources declare.
 * @param unused - What happens to entries no message matches.
 * @returns The problems (a PO that cannot be read or is keyed by another serializer), the message count, the POs
 *   read and the outputs.
 */
export function mergeCatalogs(
  catalogs: ReadonlyArray<CatalogText>,
  messages: ReadonlyArray<ProjectMessage>,
  unused: UnusedEntries
): CatalogPlan {
  const read = new Map<string, string | undefined>();
  const outputs: Array<WrittenCatalog> = [];
  const problems: Array<Problem> = [];
  for (const catalog of catalogs) {
    const existing = parseCatalog(catalog);

    if (existing._tag === "Problem") {
      problems.push(existing.problem);
      continue;
    }

    read.set(catalog.path, catalog.text);
    const version = existing.file?.meta[SERIALIZER_HEADER];

    if (version !== undefined && version !== SERIALIZER_VERSION) {
      problems.push(serializerMismatch(version, { file: catalog.shown, locale: catalog.locale }));
      continue;
    }

    const entries = mergeEntries(existing.file?.entries ?? [], messages, unused);
    outputs.push({ path: catalog.path, text: formatPo(catalog.locale, entries) });
  }

  return { problems, messages: messages.length, read, outputs: problems.length > 0 ? [] : outputs };
}
