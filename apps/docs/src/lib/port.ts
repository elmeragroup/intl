/**
 * The port the docs site's production server listens on: `PORT`, or 3033 without it, off the examples' dev ports (3030
 * to 3032). `pnpm start` (scripts/start.ts) listens on it, and the origin's localhost fallback (site-origin.ts) names
 * it, so a local production build's og:image URLs point at the server that runs it. Both read `PORT` through
 * {@link parsePort}, so they cannot disagree on a value.
 *
 * scripts/start.ts imports this module under Node's type stripping, so it uses no syntax that needs compiling.
 */

/** The port without `PORT`. */
export const DEFAULT_PORT = 3033;

/** Why `PORT` names no port the server can listen on and the origin can point at. */
export class InvalidPort extends Error {
  /** The error's tag. */
  readonly _tag = "InvalidPort" as const;

  /** The value `PORT` held. */
  readonly input: string;

  /**
   * @param input - The value `PORT` held.
   */
  constructor(input: string) {
    super(`PORT must be a whole number from 1 to 65535, got "${input}"`);
    this.input = input;
  }
}

/** A parsed port, or why `PORT` is not one. */
export type PortResult =
  | { readonly _tag: "ok"; readonly value: number }
  | { readonly _tag: "err"; readonly error: InvalidPort };

/**
 * Parse `PORT`. Unset or empty means the default; anything else must be a port in decimal digits, 1 to 65535. Port 0,
 * which asks the system for any free port, is refused: the origin could not name the port the server ends up on.
 *
 * @param input - `PORT`'s value.
 * @returns The port, or `InvalidPort`.
 */
export function parsePort(input: string | undefined): PortResult {
  if (input === undefined || input === "") {
    return { _tag: "ok", value: DEFAULT_PORT };
  }

  const port = /^\d{1,5}$/u.test(input) ? Number(input) : Number.NaN;

  return port >= 1 && port <= 65_535
    ? { _tag: "ok", value: port }
    : { _tag: "err", error: new InvalidPort(input) };
}
