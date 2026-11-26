import { expect, test } from "@playwright/test";

// Unit under test: the docs site as a visitor and a link unfurler get it, from the standalone server of a production
// build. Oracle: the frame each route promises (stated per case), and the origin the e2e build was given.

// The origin `pnpm e2e` builds with (package.json), which every og:image URL must start with.
const DOCS_ORIGIN = "http://localhost:3042";

// Every page, with its title and the image route its card must name: the landing's own, and each docs page's address
// under /og.
const PAGES = [
  { path: "/", title: "Elmera intl", image: `${DOCS_ORIGIN}/og/landing` },
  { path: "/docs", title: "Overview · Elmera intl", image: `${DOCS_ORIGIN}/og/docs` },
] as const;

test("/ renders the landing frame: the site header with the product name and a link into the docs", async ({
  page,
}) => {
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);

  const banner = page.getByRole("banner");

  await expect(banner.getByRole("link", { name: "Elmera intl" })).toHaveAttribute("href", "/");
  await expect(banner.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "/docs");
  await expect(page.getByRole("main")).toBeEmpty();
});

test("/docs renders the docs shell around the page's title, its nav entry current", async ({ page }) => {
  const response = await page.goto("/docs");

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("banner").getByRole("link", { name: "Elmera intl" })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Docs" });

  await expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveText("Overview");
  await expect(page).toHaveTitle("Overview · Elmera intl");
});

// One root layout frames both route groups; a root layout per group would make this link reload the whole document,
// which drops the marker the page sets.
test("following the header's Docs link from the landing keeps the document", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => Object.assign(window, { landingDocumentMarker: true }));
  await page.getByRole("banner").getByRole("link", { name: "Docs" }).click();

  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveText("Overview");
  expect(await page.evaluate(() => "landingDocumentMarker" in window)).toBe(true);
});

test("the skip link moves focus past the header and nav to the page", async ({ page }) => {
  await page.goto("/docs");
  await page.keyboard.press("Tab");

  const skip = page.getByRole("link", { name: "Skip to contents" });

  await expect(skip).toBeFocused();
  await skip.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
});

test("an address no route matches gets the global not-found page with a 404", async ({ page }) => {
  const response = await page.goto("/no/such/page");

  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
  await expect(page).toHaveTitle("Page not found · Elmera intl");
  await expect(page.getByRole("link", { name: "Read the docs" })).toHaveAttribute("href", "/docs");
});

for (const { path, title, image } of PAGES) {
  test(`${path} names its card ${image}, which serves a PNG`, async ({ page, request }) => {
    await page.goto(path);
    await expect(page).toHaveTitle(title);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", image);

    const response = await request.get(image);

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
    // A PNG's signature, so the body is an image and not an error page sent as one.
    expect([...(await response.body()).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
}

test("an image route outside the page list answers 404", async ({ request }) => {
  expect((await request.get("/og/docs/no-such-page")).status()).toBe(404);
});
