// The `Vary` response header (RFC 9110 §12.5.5): `*`, or a list of request header names a cache must key on. Pure: the
// intl middleware hands it the value another layer (CORS, a handler) may already have set.

/**
 * A `Vary` value that also names `header`, keeping every name already there. Names compare case-insensitively, as
 * header names do, so a name already listed is not listed again; `*` already varies by everything, so it stays as it
 * is.
 *
 * @param existing - The response's `Vary` value, if it has one.
 * @param header - The request header the response varies by.
 * @returns The `Vary` value to send.
 */
export function varyBy(existing: string | undefined, header: string): string {
  const names = (existing ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

  if (names.length === 0) {
    return header;
  }

  const lowered = new Set(names.map((name) => name.toLowerCase()));

  return lowered.has("*") || lowered.has(header.toLowerCase())
    ? names.join(", ")
    : [...names, header].join(", ");
}
