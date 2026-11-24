import { expect, test } from "@playwright/test";

import { chooseLocale, deferred, isSettingsAction } from "./browser-control";
import { EXPECTED } from "./expected-text";

// Unit under test: the settings page's saves and its draft as a visitor gets them, on the built packages: requests in
// flight, answers that arrive out of order, and bodies the action must turn back. Oracle: the English source and the
// translations in intl/*.po, written out in expected-text.ts.

test("keeps a request's button disabled until its answer arrives, and only that request's", async ({
  page,
}) => {
  // The first request waits until the test lets it through: while it is in flight, no second one can start, so a slow,
  // older answer cannot replace a newer one. The other request is independent: it answers meanwhile.
  const greeting = deferred();
  const intercepted = deferred();
  let requests = 0;
  await page.route("**/api/greeting", async (route) => {
    requests += 1;
    intercepted.settle();
    await greeting.promise;
    await route.continue();
  });
  await page.goto("/settings");
  const call = page.getByRole("button", { name: EXPECTED.en.testAlert });
  await expect(call).toBeEnabled();

  await call.click();
  // The request is held at the route before Save starts, so the two are in flight together.
  await intercepted.promise;
  await expect(call).toBeDisabled();
  const save = page.getByRole("button", { name: EXPECTED.en.save });
  await save.click();
  await expect(page.locator("#settings-saved")).toHaveText(EXPECTED.en.saved);
  await expect(save).toBeEnabled();
  await expect(call).toBeDisabled();
  await expect(page.locator("#api-greeting")).toHaveText("");
  greeting.settle();

  await expect(call).toBeEnabled();
  await expect(page.locator("#api-greeting")).toHaveText(EXPECTED.en.api);
  expect(requests).toBe(1);
});

test("keeps what the visitor typed while a save is in flight", async ({ page }) => {
  // The save's answer waits until the test lets it through; meanwhile the visitor changes the name again.
  const release = deferred();
  const intercepted = deferred();
  await page.route(isSettingsAction, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    intercepted.settle();
    await release.promise;
    await route.continue();
  });
  await page.goto("/settings");
  const name = page.getByRole("textbox", { name: EXPECTED.en.fullName });
  await name.fill("Kari Nordmann");
  await page.getByRole("button", { name: EXPECTED.en.save }).click();
  await intercepted.promise;

  await name.fill("Ola Nordmann");
  release.settle();

  await expect(page.locator("#settings-saved")).toHaveText(EXPECTED.en.saved);
  // The save set what it sent, Kari; the name typed since is still in the field, and still to be saved.
  await expect(name).toHaveValue("Ola Nordmann");
  await expect(page.locator("#settings-state")).toHaveText(EXPECTED.en.unsaved);

  // Discard returns the draft to what the save saved: Kari, and nothing left to save.
  await page.getByRole("button", { name: EXPECTED.en.discard }).click();
  await expect(name).toHaveValue("Kari Nordmann");
  await expect(page.locator("#settings-state")).toHaveText(EXPECTED.en.unchanged);
});

// The settings draft as a save's body carries it: each field a string, a number or a flag.
type DraftBody = Readonly<Record<string, string | number | boolean>>;

// The action is an endpoint anyone can post to: whatever its body holds, it decodes it before it parses it, and a body
// that does not decode is a draft to fix, said in the visitor's language.
for (const { name, forge } of [
  {
    name: "a missing field",
    forge: (draft: DraftBody) =>
      Object.fromEntries(Object.entries(draft).filter(([field]) => field !== "name")),
  },
  {
    name: 'the string "false" for a switch',
    forge: (draft: DraftBody) => ({ ...draft, alertsOn: "false" }),
  },
] as const) {
  test(`turns back a save whose body holds ${name}`, async ({ page, context }) => {
    await chooseLocale(context, "nb");
    await page.route(isSettingsAction, async (route) => {
      const body = route.request().postData();
      if (route.request().method() !== "POST" || body === null) {
        await route.continue();
        return;
      }
      // SAFETY: a server action's body is its arguments as a JSON array, and this action's one argument is the form's
      // draft, an object of its fields: the request was the page's own Save.
      const [draft] = JSON.parse(body) as [DraftBody];
      await route.continue({ postData: JSON.stringify([forge(draft)]) });
    });
    await page.goto("/settings");

    await page.getByRole("button", { name: EXPECTED.nb.save }).click();

    await expect(page.locator("#settings-saved")).toHaveText(EXPECTED.nb.invalidSettings);
    await expect(page.locator("#settings-state")).toHaveText(EXPECTED.nb.unchanged);
  });
}

// A field marked on Save is marked while it is still wrong, not after the visitor fixes it: a name typed back, or a
// threshold whose alerts are turned off, which no longer needs one.
test("marks a field only while it is still wrong", async ({ page }) => {
  await page.goto("/settings");
  const name = page.getByRole("textbox", { name: EXPECTED.en.fullName });
  await expect(name).toBeEnabled();
  const save = page.getByRole("button", { name: EXPECTED.en.save });
  const nameError = page.getByText("Enter your name.");
  const thresholdError = page.getByText("Enter a whole number of øre from 1 to 999.");

  await name.fill("");
  await save.click();
  await expect(nameError).toBeVisible();
  await name.fill("Ingrid Haugen");

  await expect(page.locator("#settings-state")).toHaveText(EXPECTED.en.unchanged);
  await expect(nameError).toHaveCount(0);

  await page.getByRole("textbox", { name: "Alert threshold, øre/kWh" }).fill("0");
  await save.click();
  await expect(thresholdError).toBeVisible();
  await page.getByRole("switch", { name: "Price alerts" }).click();

  await expect(thresholdError).toHaveCount(0);
});
