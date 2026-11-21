// Runs the CLI entry from source, as the bin runs the build: node strips the types, and this hook resolves the
// extensionless relative imports the bundler resolves.
import { fileURLToPath } from "node:url";

const RESOLVE_TS = `import { registerHooks } from "node:module"; registerHooks({ resolve(s, c, n) { try { return n(s, c); } catch (e) { if (s.startsWith(".")) return n(s + ".ts", c); throw e; } } });`;
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/**
 * Node arguments that run `elmera-intl` from source.
 *
 * @param args - The CLI's own arguments.
 * @returns The arguments to pass to `process.execPath`.
 */
export function cliFromSource(...args: ReadonlyArray<string>): Array<string> {
  return ["--import", `data:text/javascript,${encodeURIComponent(RESOLVE_TS)}`, CLI, ...args];
}
