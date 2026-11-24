import { expect, test } from "@playwright/test";

import { deferred, isServerFunction } from "./browser-control";
import { EXPECTED } from "./expected-text";

// Unit under test: the settings page's saves and its draft as a visitor gets them, on the built packages: requests in
// flight, answers that arrive out of order, and a draft that outlives a failed reload. Oracle: the English source and
// the translations in src/intl/*.po, written out in expected-text.ts.

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
  await page.route(isServerFunction, async (route) => {
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

// Which of two saves answering out of order sets the saved settings is settleSave's rule (test/settings.test.ts). In the
// page, a save in flight across a switch keeps the draft it was sent with, under the new language's labels, and its
// answer still sets the saved settings once it arrives.
test("keeps the draft and a save in flight across a switch", async ({ page }) => {
  // The save's answer waits until the test lets it through. The switch's own save is a POST too, so only the settings
  // save that carries the name is held.
  const release = deferred();
  const sent = deferred();
  await page.route(isServerFunction, async (route) => {
    const request = route.request();
    if (request.method() === "POST" && (request.postData() ?? "").includes("Kari Nordmann")) {
      sent.settle();
      await release.promise;
    }
    await route.continue();
  });
  await page.goto("/settings");
  const status = page.locator("#settings-state");
  await page.getByRole("textbox", { name: EXPECTED.en.fullName }).fill("Kari Nordmann");
  await page.getByRole("button", { name: EXPECTED.en.save }).click();
  await sent.promise;

  await page.getByRole("button", { name: EXPECTED.sv.language }).click();

  await expect(page.locator("h1")).toHaveText(EXPECTED.sv.settings);
  const name = page.getByRole("textbox", { name: EXPECTED.sv.fullName });
  await expect(name).toHaveValue("Kari Nordmann");
  await expect(status).toHaveText(EXPECTED.sv.unsaved);
  release.settle();
  await expect(status).toHaveText(EXPECTED.sv.unchanged);
  await expect(name).toHaveValue("Kari Nordmann");
});

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

test("offers to load again when the loaders fail after the choice is saved", async ({ page }) => {
  // The switch saves the choice (a POST), then the loaders re-run (GETs); while `failing`, every GET fails.
  let failing = false;
  await page.route(isServerFunction, (route) =>
    failing && route.request().method() === "GET" ? route.abort() : route.continue()
  );
  await page.goto("/settings");
  const swedish = page.getByRole("button", { name: EXPECTED.sv.language });
  await expect(swedish).toBeEnabled();
  // A draft the visitor has not saved: the error replaces the form, and the form that comes back must still hold it.
  await page.getByRole("textbox", { name: EXPECTED.en.fullName }).fill("Kari Nordmann");
  await expect(page.locator("#settings-state")).toHaveText(EXPECTED.en.unsaved);
  failing = true;

  await swedish.click();

  // The shell still holds the English config it loaded, so the page says so in English.
  await expect(page.locator("#load-error")).toHaveText(EXPECTED.en.loadError);
  failing = false;
  await page.getByRole("button", { name: EXPECTED.en.tryAgain }).click();

  await expect(page.locator("h1")).toHaveText(EXPECTED.sv.settings);
  await expect(page.locator("html")).toHaveAttribute("lang", "sv");
  await expect(page.locator("#load-error")).toHaveCount(0);
  // The draft outlived the error: the edited name, still unsaved, under Swedish labels.
  await expect(page.getByRole("textbox", { name: EXPECTED.sv.fullName })).toHaveValue("Kari Nordmann");
  await expect(page.locator("#settings-state")).toHaveText(EXPECTED.sv.unsaved);
});
