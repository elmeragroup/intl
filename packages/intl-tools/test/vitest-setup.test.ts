import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { runOnceInProcess } from "../src/command-run";
import checkIntlCatalogs from "../src/vitest";

const CONFIG = { include: ["src/**/*.tsx"], catalogs: "messages/{locale}.po", locales: ["nb"] };
const PAGE = `import { T } from "@elmeragroup/intl/react";\nexport function Page() { return <T>Order</T>; }\n`;

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "elmera-intl-vitest-"));
  write("elmera-intl.json", JSON.stringify(CONFIG));
  write("src/page.tsx", PAGE);
  // Check prints its problems to stderr; the thrown message is the contract here.
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

// The test process runs in packages/intl-tools, so a setup that checked process.cwd() would not see this project.
it("checks the vitest project root, not the process cwd", async () => {
  const extract = () =>
    runOnceInProcess(
      "extract",
      { configPath: join(root, "elmera-intl.json"), crash: "reject" },
      { stdout: () => undefined, stderr: () => undefined }
    );
  expect(await extract()).toBe(0);
  // Check also flags an empty msgstr, so translate the one message.
  const po = join(root, "messages/nb.po");
  writeFileSync(
    po,
    readFileSync(po, "utf8").replace('msgid "Order"\nmsgstr ""', 'msgid "Order"\nmsgstr "Ordre"')
  );
  expect(await extract()).toBe(0);
  await expect(checkIntlCatalogs({ config: { root } })).resolves.toBeUndefined();

  write("src/page.tsx", `${PAGE}export function Greeting() { return <T>Hello</T>; }\n`);
  await expect(checkIntlCatalogs({ config: { root } })).rejects.toThrow(
    `elmera-intl check found problems in ${root}`
  );
});
