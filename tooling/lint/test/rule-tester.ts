// RuleTester wired to Vitest, and paths into the fixture packages the rules read manifests from.
import { fileURLToPath } from "node:url";
import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

RuleTester.describe = describe;
RuleTester.it = it;

/**
 * A RuleTester that parses TypeScript with JSX as ES modules.
 *
 * @returns The tester.
 */
export function createTester(): RuleTester {
  return new RuleTester({ languageOptions: { sourceType: "module", parserOptions: { lang: "tsx" } } });
}

/**
 * An absolute path inside `test/fixtures`, whose package.json files stand in for the workspace's.
 *
 * @param path - The path below `test/fixtures`, such as `runtime/src/core.ts`.
 * @returns The absolute path; the file itself need not exist.
 */
export function fixture(path: string): string {
  return fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url));
}
