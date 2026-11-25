"use client";
// The header across the top of every page, ported from Fuse's app-shell block (app-header.tsx at Fuse 9be80460): the
// sidebar toggle, a breadcrumb to the current page, the command menu's search button and the user menu.
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Breadcrumb } from "@elmeragroup/fuse/breadcrumb";
import { Separator } from "@elmeragroup/fuse/separator";
import { Sidebar } from "@elmeragroup/fuse/sidebar";
import { T, useT } from "@elmeragroup/intl/react";

import { APP_HOME, pageForPath } from "./app-config";
import { CommandMenu } from "./command-menu";
import { UserMenu } from "./user-menu";

/** The app's header. */
export function AppHeader() {
  const t = useT();
  const page = pageForPath(usePathname());

  return (
    // Sticks on a phone, where the document scrolls; from md the page scrolls under it instead.
    <header className="md:static md:rounded-t-xl sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
      <Sidebar.Trigger />
      <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-auto" />
      <Breadcrumb.Root className="min-w-0">
        <Breadcrumb.List>
          {/* The app's name gives way to the page's on a narrow screen. */}
          <Breadcrumb.Item className="sm:inline-flex hidden">
            {page?.href === APP_HOME ? (
              <span>
                <T>Back office</T>
              </span>
            ) : (
              <Breadcrumb.Link render={<Link href={APP_HOME} />}>
                <T>Back office</T>
              </Breadcrumb.Link>
            )}
          </Breadcrumb.Item>
          <Breadcrumb.Separator className="sm:inline-flex hidden" />
          <Breadcrumb.Item>
            <Breadcrumb.Page>{page === undefined ? t("Not found") : t.from(page.label)}</Breadcrumb.Page>
          </Breadcrumb.Item>
        </Breadcrumb.List>
      </Breadcrumb.Root>
      <div className="ml-auto flex items-center gap-2">
        <CommandMenu />
        <UserMenu />
      </div>
    </header>
  );
}
