// The intl/configure.ts shape: imports the package, declares no messages.
import { cookies } from "next/headers";

import type { Catalog } from "@elmeragroup/intl/core";
import { configureNextIntl } from "@elmeragroup/intl/next/server";

import { formats } from "./formats";

configureNextIntl({
  resolveLocale: async () => ((await cookies()).get("locale")?.value === "en" ? "en" : "no"),
  resolveTimeZone: () => "Europe/Oslo",
  formats,
  loadCatalog: async (locale): Promise<Catalog> =>
    locale === "no" ? (await import("./no.po")).default : (await import("./no.po?source")).default,
});
