// Accept-Language negotiation: which of an app's locales a request's header asks for. Pure and platform-neutral, so
// any host (a Next adapter, a Start server function, an Effect middleware) calls it with the header it read.

// A concrete language range (RFC 4647 §2.1): a primary subtag of 1 to 8 letters and subtags of 1 to 8 letters or
// digits. The range `*` is well formed but not concrete: it names no locale, so it is neither an entry nor an alias.
const CONCRETE_RANGE = /^[A-Za-z]{1,8}(?:-[A-Za-z\d]{1,8})*$/u;

// An Accept-Language weight (RFC 9110 §12.4.2): `q` in either case, then 0 to 1 with at most three decimals.
const WEIGHT = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/iu;

/**
 * Options of `negotiateLocale`.
 *
 * @template L - The locales the app ships.
 */
export type NegotiateLocaleOptions<L extends string> = {
  /**
   * Ranges standing for a shipped locale, case-insensitive, checked along the lookup chain after the locales
   * themselves: `{ no: "nb", nn: "nb" }`, `{ "zh-HK": "zh-Hant" }`. Each target is written exactly as in `locales`.
   */
  readonly aliases?: Readonly<Record<string, L>>;
};

// One well-formed `range;q=weight` entry, its range lowercased. An entry without a weight weighs 1; one with a
// malformed range or weight, or anything after the weight, is dropped rather than given the default. A `*` entry is
// dropped at any weight: the caller's default answers it, and a rejected `*` excludes nothing.
type Entry = { readonly range: string; readonly quality: number };

// HTTP's optional whitespace (RFC 9110 §5.6.3) is spaces and horizontal tabs, nothing else: an entry padded with any
// other space is malformed. A loop rather than a regular expression, which would backtrack quadratically on a header
// of whitespace.
function isOws(text: string, index: number): boolean {
  const char = text.charAt(index);

  return char === " " || char === "\t";
}

function trimOws(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isOws(text, start)) {
    start += 1;
  }
  while (end > start && isOws(text, end - 1)) {
    end -= 1;
  }

  return text.slice(start, end);
}

function parseEntry(entry: string): ReadonlyArray<Entry> {
  const [range = "", weight, ...rest] = entry.split(";");
  const trimmed = trimOws(range);
  const quality =
    weight === undefined ? "1" : rest.length === 0 ? WEIGHT.exec(trimOws(weight))?.[1] : undefined;

  return CONCRETE_RANGE.test(trimmed) && quality !== undefined
    ? [{ range: trimmed.toLowerCase(), quality: Number(quality) }]
    : [];
}

// What a lowercased name resolves to, and how: the locale it names, or else its alias's target.
type Resolution<L extends string> = { readonly locale: L; readonly via: "name" | "alias" };

// The names a range or prefix can resolve through: the locales and the aliases by their lowercased text, the locales
// winning over an alias of the same text, so every name resolves exact-first. Header text is only ever a key of this
// map, never an object property. Two locales one name apart in case would make the answer depend on the list's order,
// and an alias must be a concrete language range naming one of `locales` as written there, so the answer is always
// written exactly as in `locales`; anything else throws.
function nameTable<L extends string>(
  locales: ReadonlyArray<L>,
  aliases: Readonly<Record<string, L>>
): ReadonlyMap<string, Resolution<L>> {
  const table = new Map<string, Resolution<L>>();
  for (const locale of locales) {
    const key = locale.toLowerCase();
    const existing = table.get(key);
    if (existing !== undefined && existing.locale !== locale) {
      throw new RangeError(
        `negotiateLocale: the locales "${existing.locale}" and "${locale}" differ only in case`
      );
    }
    table.set(key, { locale, via: "name" });
  }
  const shipped = new Set<string>(locales);
  const aliasKeys = new Set<string>();
  for (const [range, locale] of Object.entries(aliases)) {
    if (!CONCRETE_RANGE.test(range)) {
      throw new RangeError(`negotiateLocale: the alias "${range}" is not a concrete language range`);
    }
    if (!shipped.has(locale)) {
      throw new RangeError(
        `negotiateLocale: the alias "${range}" names "${locale}", which is not in locales`
      );
    }
    const key = range.toLowerCase();
    if (aliasKeys.has(key)) {
      throw new RangeError(`negotiateLocale: the alias "${range}" is given twice, in different case`);
    }
    aliasKeys.add(key);
    if (!table.has(key)) {
      table.set(key, { locale, via: "alias" });
    }
  }

  return table;
}

// A lookup (RFC 4647 §3.4) of one well-formed range: the range itself, then each shorter prefix whose last subtag is
// not a single character, longest first, so `en-GB-x-a-b` → `en-GB-x-a` and `en-GB-x` are skipped for `en-GB`, and
// `x-team` has no prefix at all. The range is header text, so the walk visits its subtag boundaries once, backwards,
// and copies out only a prefix as long as some name in the table: linear in the range, where dropping one subtag at a
// time by splitting and joining would be quadratic. `match` decides each prefix tried; the first it accepts answers.
function lookup<T>(
  range: string,
  lengths: ReadonlySet<number>,
  match: (prefix: string) => T | undefined
): T | undefined {
  const whole = lengths.has(range.length) ? match(range) : undefined;
  if (whole !== undefined) {
    return whole;
  }
  // Each `end` is a `-`, so the prefix is `range.slice(0, end)`, `end` characters long. A range starts with a letter,
  // so the walk stops before index 0.
  for (let end = range.lastIndexOf("-"); end > 0; end = range.lastIndexOf("-", end - 1)) {
    // The prefix's last subtag is one character when it starts the range or follows `-`.
    const singleton = end === 1 || range.charAt(end - 2) === "-";
    const found = !singleton && lengths.has(end) ? match(range.slice(0, end)) : undefined;
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

/**
 * The most preferred of `locales` an Accept-Language header accepts: RFC 9110 §12.4.2 weights, with RFC 4647 §3.4
 * lookup, which drops a range's subtags until one of `locales`, or an alias of one, matches. Each prefix resolves
 * exact-first: to the locale it names, else to its alias's target. Equal weights keep the header's order.
 *
 * Weight 0 means "not acceptable": a range the header both asks for and rejects is skipped; a locale a rejected range
 * names exactly is no answer by any path, so `nb-NO, nb;q=0` is not `nb`; and the target of a rejected alias is no
 * answer through an alias, so with `{ no: "nb", nn: "nb" }`, when `no` is not shipped, `nn, no;q=0` is not `nb`, but
 * `nb, no;q=0` is. The alias is the app's mapping, not the client's, so it never takes away a locale the client asked
 * for by name.
 *
 * @template L - The locales the app ships, inferred from `locales`.
 * @template AliasTarget - The locales the aliases name, each one of `L`; inferred from `options`, it never widens `L`.
 * @param acceptLanguage - The request's Accept-Language header, if any.
 * @param locales - The locales the app ships, each named once whatever its case.
 * @param options - Aliases of the locales.
 * @returns The best eligible explicit match from `locales`, or `undefined` when no positive, concrete range resolves
 *   (a wildcard-only header included); the caller picks its default.
 * @throws A `RangeError` when two `locales` differ only in case, or an alias is not a concrete language range, names a
 *   locale not in `locales`, or is given twice: the app's configuration is wrong, whatever the header.
 */
export function negotiateLocale<const L extends string, AliasTarget extends L = L>(
  acceptLanguage: string | null | undefined,
  locales: ReadonlyArray<L>,
  options?: NegotiateLocaleOptions<AliasTarget>
): L | undefined {
  const names = nameTable<L>(locales, options?.aliases ?? {});
  // A prefix matches only a name of its own length, so lookup copies out no other.
  const lengths = new Set(Array.from(names.keys(), (name) => name.length));

  const entries = (acceptLanguage ?? "").split(",").flatMap((entry) => parseEntry(entry));
  const rejected = new Set(entries.filter(({ quality }) => quality === 0).map(({ range }) => range));
  // A rejected range resolves as an accepted prefix does, exact-first and without lookup. The locale it names is
  // excluded on every path; its alias's target only through an alias.
  const exactlyRejected = new Set<L>();
  const aliasRejected = new Set<L>();
  for (const range of rejected) {
    const resolution = names.get(range);
    if (resolution !== undefined) {
      (resolution.via === "name" ? exactlyRejected : aliasRejected).add(resolution.locale);
    }
  }
  const eligible = (prefix: string): L | undefined => {
    const resolution = names.get(prefix);
    if (resolution === undefined || exactlyRejected.has(resolution.locale)) {
      return undefined;
    }

    return resolution.via === "alias" && aliasRejected.has(resolution.locale) ? undefined : resolution.locale;
  };
  // `sort` is stable (ES2019), so equal weights keep the header's order. It sorts the fresh array `filter` returns.
  const accepted = entries
    .filter(({ quality, range }) => quality > 0 && !rejected.has(range))
    .sort((left, right) => right.quality - left.quality);

  for (const { range } of accepted) {
    const locale = lookup(range, lengths, eligible);
    if (locale !== undefined) {
      return locale;
    }
  }

  return undefined;
}
