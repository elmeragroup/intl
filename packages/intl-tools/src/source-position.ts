// Maps an offset in compiled code back to a line and column in the source it came from, through the compiler's
// source map, so a failure found in compiled JSX points at what the author wrote.
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";

/** A 1-based line and 0-based column (the ESLint/oxlint convention). */
export type SourcePosition = { readonly line: number; readonly column: number };

/**
 * The position of an offset in a text.
 *
 * @param text - The text.
 * @param offset - A UTF-16 offset into it.
 * @returns Its line (1-based) and column (0-based).
 */
export function positionAt(text: string, offset: number): SourcePosition {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;

  return { line: before.split("\n").length, column: offset - lineStart };
}

/**
 * Build a mapper from compiled-code positions to source positions.
 *
 * @param mappings - The source map's `mappings` field (one source, as a single-file compiler emits).
 * @returns A function from a compiled position to the source position of the nearest segment at or before it on that
 *   line, or `undefined` when there is none or it maps to no source.
 */
export function createSourceMapper(
  mappings: string
): (generated: SourcePosition) => SourcePosition | undefined {
  const map = new TraceMap({ version: 3, sources: [""], names: [], mappings });

  return (generated) => {
    const { line, column } = originalPositionFor(map, generated);

    return line === null ? undefined : { line, column };
  };
}
