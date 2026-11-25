"use client";
// The app's frame, ported from Fuse's app-shell block (app-shell.tsx at Fuse 9be80460): the providers, a skip link, the
// sidebar and the inset panel with the header and the page. The layout mounts it once, so the sidebar, the command
// menu and the toasts keep their state while the pages change.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Sidebar } from "@elmeragroup/fuse/sidebar";
import { LocaleProvider } from "@elmeragroup/fuse/theme";
import { Toast } from "@elmeragroup/fuse/toast";
import { Tooltip } from "@elmeragroup/fuse/tooltip";
import { T, useIntl, useT } from "@elmeragroup/intl/react";

import { fuseLocale } from "../intl/locale";
import { APP_PAGES, pageForPath, SIDEBAR_COOKIE } from "./app-config";
import { AppHeader } from "./app-header";
import { AppSidebar } from "./app-sidebar";

// The id of the page content the skip link moves to.
const CONTENT_ID = "app-content";

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

// Remembers the sidebar's state for the next request's first paint. Fuse also writes its own `sidebar:state` cookie,
// which every app on the host shares; the layout reads only this one, named for the app.
function rememberSidebar(open: boolean): void {
  document.cookie = `${SIDEBAR_COOKIE}=${String(open)}; path=/; max-age=${String(ONE_YEAR_IN_SECONDS)}; samesite=lax`;
}

// The pages as plain links under the header, for a narrow screen with JavaScript off: there the sidebar is a Sheet that
// only script opens, so without this the pages beyond the first would be out of reach. The server renders it inside
// <noscript>, which a browser running script never shows, and from md the sidebar is in the page anyway.
function PageLinksWithoutScript() {
  const t = useT();
  const current = pageForPath(usePathname());

  return (
    <noscript>
      <nav aria-label={t("Pages")} className="md:hidden border-b border-border px-4 py-2">
        <ul className="text-sm flex flex-wrap gap-x-4 gap-y-1">
          {APP_PAGES.map((page) => (
            <li key={page.href}>
              <Link
                href={page.href}
                aria-current={current?.href === page.href ? "page" : undefined}
                className="underline-offset-4 hover:underline aria-[current=page]:font-medium">
                {t.from(page.label)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </noscript>
  );
}

/**
 * The shell around every page. Fuse's own strings (the sidebar toggle, the table pagination, the chart tables) come
 * from its LocaleProvider, driven by the request's locale; every date and chart in it runs on the configured zone,
 * Oslo's, wherever the server or the visitor is.
 *
 * @param props - The sidebar's state as the visitor left it, and the current page.
 */
export function AppShell({
  sidebarOpen,
  children,
}: {
  readonly sidebarOpen: boolean;
  readonly children: ReactNode;
}) {
  const intl = useIntl();
  const t = useT();
  const pathname = usePathname();
  const content = useRef<HTMLDivElement>(null);
  const shownPath = useRef(pathname);
  const [open, setOpen] = useState(sidebarOpen);
  // The phone's sidebar Sheet. Every navigation Next commits closes it, a link's or the browser's Back and Forward
  // alike: it closes in the render that shows the new page, so it is closed by the time the title below takes focus,
  // and never covers the page it led to.
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobilePath, setMobilePath] = useState(pathname);
  if (mobilePath !== pathname) {
    setMobilePath(pathname);
    setMobileOpen(false);
  }

  // Next swaps the page on a client navigation and leaves focus where it was: in the sidebar, or on the trigger of the
  // menu that navigated. So the new page's title takes focus, and the next Tab starts in the page. The first load keeps
  // the browser's own focus.
  useEffect(() => {
    if (shownPath.current === pathname) {
      return;
    }
    shownPath.current = pathname;
    const title = content.current?.querySelector<HTMLElement>("[data-page-title]");
    (title ?? content.current)?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <LocaleProvider locale={fuseLocale(intl.locale)} timeZone={intl.timeZone}>
      <Tooltip.Provider>
        <Toast.Provider>
          {/* Hidden until a keyboard reaches it, then a pill over the header's start. */}
          <a
            href={`#${CONTENT_ID}`}
            className="text-sm font-medium focus-visible:shadow-md sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-3 focus-visible:left-3 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-background focus-visible:px-3 focus-visible:py-2 focus-visible:outline-2 focus-visible:outline-ring">
            <T>Skip to content</T>
          </a>
          <Sidebar.Provider
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              rememberSidebar(next);
            }}
            openMobile={mobileOpen}
            onOpenMobileChange={setMobileOpen}>
            <AppSidebar />
            {/* From md the inset is a panel of the viewport's height that scrolls its page inside, as a desktop app
              does. On a phone the document scrolls and the header sticks. */}
            <Sidebar.Inset className="md:h-[calc(100svh-(--spacing(4)))] md:overflow-hidden">
              <AppHeader />
              <PageLinksWithoutScript />
              {/* Keyed by route, so each page opens at its top, as a new document would. */}
              <div
                key={pathname}
                ref={content}
                id={CONTENT_ID}
                tabIndex={-1}
                className="md:min-h-0 md:overflow-y-auto flex flex-1 flex-col outline-none">
                {children}
              </div>
            </Sidebar.Inset>
          </Sidebar.Provider>
          <Toast.Viewport aria-label={t("Notifications")} />
        </Toast.Provider>
      </Tooltip.Provider>
    </LocaleProvider>
  );
}
