// The portal's pages, ported from Fuse's app-shell block (app-config.ts at Fuse 9be80460). The sidebar, the breadcrumb,
// the command menu and each page's header read the one page list, so a new page shows up in all four at once. Each
// name and description is a msg() descriptor: the component that shows it translates it in the visitor's language.
import type { ComponentType } from "react";

import { Gauge, Gear, Receipt, SquaresFour } from "@elmeragroup/fuse/icons";
import type { ElmeraIconProps } from "@elmeragroup/fuse/icons";
import type { Descriptor } from "@elmeragroup/intl/core";
import { msg } from "@elmeragroup/intl/core";

/** The home route, which the logo, the breadcrumb and Overview link to: the app owns the whole site. */
export const APP_HOME = "/";

/** The cookie that remembers whether the sidebar is open, named for the app as the locale cookie is. */
export const SIDEBAR_COOKIE = "next-example-sidebar";

/** One of the sidebar's groups. */
export type AppPageGroup = "portfolio" | "billing" | "account";

/** A page of the app, by its id. */
export type AppPageId = "overview" | "metering-points" | "invoices" | "settings";

/** One page of the app. */
export type AppPage = {
  readonly id: AppPageId;
  /** The page's route. */
  readonly href: string;
  /** The page's name in the sidebar, the breadcrumb, its heading and the command menu. */
  readonly label: Descriptor;
  /** One line under the page's heading. */
  readonly description: Descriptor;
  readonly icon: ComponentType<ElmeraIconProps>;
  readonly group: AppPageGroup;
  /** Extra words the command menu matches, in the visitor's language. */
  readonly keywords: Descriptor;
};

/** Each page by its id, for the page's own header. */
export const APP_PAGE_BY_ID = {
  overview: {
    id: "overview",
    href: APP_HOME,
    label: msg("Overview"),
    description: msg("Consumption, spot price and invoicing across the portfolio."),
    icon: SquaresFour,
    group: "portfolio",
    keywords: msg("dashboard home key figures", { context: "search words" }),
  },
  "metering-points": {
    id: "metering-points",
    href: "/metering-points",
    label: msg("Metering points"),
    description: msg("Every point we supply, with its contract and its last 30 days."),
    icon: Gauge,
    group: "portfolio",
    keywords: msg("customers meters gsrn elhub", { context: "search words" }),
  },
  invoices: {
    id: "invoices",
    href: "/invoices",
    label: msg("Invoices"),
    description: msg("February's invoices, their payments and what each one charged."),
    icon: Receipt,
    group: "billing",
    keywords: msg("bills payments overdue", { context: "search words" }),
  },
  settings: {
    id: "settings",
    href: "/settings",
    label: msg("Settings"),
    description: msg("Your profile, language, invoicing defaults and notifications."),
    icon: Gear,
    group: "account",
    keywords: msg("profile language preferences notifications", { context: "search words" }),
  },
} as const satisfies Readonly<Record<AppPageId, AppPage & { readonly id: AppPageId }>>;

/** Every page, in sidebar order; Overview is the home. */
export const APP_PAGES: ReadonlyArray<AppPage> = [
  APP_PAGE_BY_ID.overview,
  APP_PAGE_BY_ID["metering-points"],
  APP_PAGE_BY_ID.invoices,
  APP_PAGE_BY_ID.settings,
];

/** The sidebar's groups with their names, in order. */
export const APP_PAGE_GROUPS: ReadonlyArray<{
  readonly id: AppPageGroup;
  readonly label: Descriptor;
  readonly pages: ReadonlyArray<AppPage>;
}> = [
  { id: "portfolio", label: msg("Portfolio"), pages: APP_PAGES.filter((page) => page.group === "portfolio") },
  { id: "billing", label: msg("Billing"), pages: APP_PAGES.filter((page) => page.group === "billing") },
  { id: "account", label: msg("Account"), pages: APP_PAGES.filter((page) => page.group === "account") },
];

/**
 * The page a pathname shows: the page whose route it is, once a trailing slash is dropped. A path no page owns, a
 * missing one below a page's route (`/invoices/missing`) included, is a 404 and shows none, so the sidebar marks no
 * page as current there.
 *
 * @param pathname - The current pathname, as `usePathname` returns it.
 * @returns The page, or `undefined` outside the app.
 */
export function pageForPath(pathname: string): AppPage | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/$/u, "") : pathname;

  return APP_PAGES.find((page) => page.href === path);
}
