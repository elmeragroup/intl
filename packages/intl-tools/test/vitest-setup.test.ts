import { mkdirSync } from "node:fs";
import process from "node:process";
import { expect, test, vi } from "vitest";

import { runOnceInProcess } from "../src/command-run";
import checkIntlCatalogs from "../src/vitest";
import { openProject } from "./project-fixture";

const CONFIG = { include: ["src/**/*.tsx"], catalogs: "messages/{locale}.po", locales: ["nb"] };
const PAGE = `import { T } from "@elmeragroup/intl/react";\nexport function Page() { return <T>Order</T>; }\n`;

// Each test owns its project (see `Project`), with one source; every wait ends by its deadline.
const it = test.extend("project", ({ task }, { onCleanup }) => {
  const { project, close } = openProject("elmera-intl-vitest-", task.timeout);
  onCleanup(close);
  project.write("elmera-intl.json", JSON.stringify(CONFIG));
  project.write("src/page.tsx", PAGE);
  // Check prints its problems to stderr; the thrown message is the contract here.
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  project.defer(() => {
    vi.restoreAllMocks();
  });

  return project;
});

// The test process runs in packages/intl-tools, so a setup that checked process.cwd() would not see this project.
it("checks the vitest project root, not the process cwd", async ({ project }) => {
  const { root } = project;
  const extract = () =>
    project.within(
      runOnceInProcess(
        "extract",
        { configPath: project.path("elmera-intl.json"), crash: "reject" },
        { stdout: () => undefined, stderr: () => undefined }
      ),
      "extract"
    );
  expect(await extract()).toBe("ok");
  // Check also flags an empty msgstr, so translate the one message.
  project.write(
    "messages/nb.po",
    project.read("messages/nb.po").replace('msgid "Order"\nmsgstr ""', 'msgid "Order"\nmsgstr "Ordre"')
  );
  expect(await extract()).toBe("ok");
  await expect(project.within(checkIntlCatalogs({ config: { root } }), "the setup")).resolves.toBeUndefined();

  project.write("src/page.tsx", `${PAGE}export function Greeting() { return <T>Hello</T>; }\n`);
  await expect(project.within(checkIntlCatalogs({ config: { root } }), "the setup")).rejects.toThrow(
    `elmera-intl check found problems in ${root}`
  );
});

// Unit under test: the setup's run of check, when check itself crashes. Oracle: the layer 2 setup's contract, by hand:
// a crash is printed as the CLI prints it (`elmera-intl failed: ` and the thrown Error's own stack) and stops the run
// with "could not run", not "found problems". A directory where the nb catalog goes makes check's read throw EISDIR, an
// I/O failure it does not classify.
it("stops the run with the crash printed when check cannot run", async ({ project }) => {
  mkdirSync(project.path("messages/nb.po"), { recursive: true });
  // The fixture's stub of stderr, which spying again returns.
  const stderr = vi.spyOn(process.stderr, "write");

  await expect(
    project.within(checkIntlCatalogs({ config: { root: project.root } }), "the setup")
  ).rejects.toThrow(`elmera-intl check could not run in ${project.root} (output above)`);
  expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toMatch(
    /^elmera-intl failed: Error: EISDIR/u
  );
});
