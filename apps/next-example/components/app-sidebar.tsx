"use client";
// The sidebar, ported from Fuse's app-shell block (app-sidebar.tsx at Fuse 9be80460): the app's mark, the pages in
// their groups and Settings at the foot. On desktop it collapses to icons, each with a tooltip; below 768px it is a
// Sheet that a page link closes.
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Lightning } from "@elmeragroup/fuse/icons";
import { Sidebar, useSidebar } from "@elmeragroup/fuse/sidebar";
import { T, useFormat, useT } from "@elmeragroup/intl/react";

import { OVERDUE_COUNT } from "../data/invoice-run";
import { APP_HOME, APP_PAGE_GROUPS, pageForPath } from "./app-config";
import type { AppPage } from "./app-config";

function PageLink({ page, current }: { readonly page: AppPage; readonly current: boolean }) {
  const t = useT();
  const format = useFormat();
  const { setOpenMobile } = useSidebar();
  const Icon = page.icon;
  const label = t.from(page.label);

  return (
    <Sidebar.MenuItem>
      <Sidebar.MenuButton
        isActive={current}
        tooltip={label}
        render={
          <Link
            href={page.href}
            aria-current={current ? "page" : undefined}
            onClick={() => {
              setOpenMobile(false);
            }}
          />
        }>
        <Icon />
        <span>{label}</span>
      </Sidebar.MenuButton>
      {/* Overdue invoices are counted, so they get seen. The badge shows the number; a screen reader reads one plural
          message in its place, so each language says the count and its noun in its own grammar. */}
      {page.id === "invoices" && OVERDUE_COUNT > 0 ? (
        <Sidebar.MenuBadge>
          <span aria-hidden>{format.number(OVERDUE_COUNT)}</span>
          <span className="sr-only">
            {t("{count, plural, one {# overdue invoice} other {# overdue invoices}}", {
              count: OVERDUE_COUNT,
            })}
          </span>
        </Sidebar.MenuBadge>
      ) : null}
    </Sidebar.MenuItem>
  );
}

/** The app's sidebar: every page, in its group, in the visitor's language. */
export function AppSidebar() {
  const t = useT();
  const current = pageForPath(usePathname());
  const { setOpenMobile } = useSidebar();
  const groups = APP_PAGE_GROUPS.filter((group) => group.id !== "account");
  const account = APP_PAGE_GROUPS.find((group) => group.id === "account")?.pages ?? [];

  return (
    <Sidebar.Root collapsible="icon" variant="inset">
      <Sidebar.Header>
        <Sidebar.Menu>
          <Sidebar.MenuItem>
            <Sidebar.MenuButton
              size="lg"
              tooltip={t("Overview")}
              render={
                <Link
                  href={APP_HOME}
                  onClick={() => {
                    setOpenMobile(false);
                  }}
                />
              }>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-brand text-sidebar-brand-foreground">
                <Lightning className="size-4.5" />
              </span>
              <span className="leading-tight grid min-w-0 flex-1 text-left">
                <span className="text-sm font-semibold truncate">
                  <T>Back office</T>
                </span>
                <span className="text-xs truncate text-sidebar-foreground/70">
                  <T>Power retail</T>
                </span>
              </span>
            </Sidebar.MenuButton>
          </Sidebar.MenuItem>
        </Sidebar.Menu>
      </Sidebar.Header>
      <Sidebar.Content>
        {groups.map((group) => (
          <Sidebar.Group key={group.id}>
            <Sidebar.GroupLabel>{t.from(group.label)}</Sidebar.GroupLabel>
            <Sidebar.GroupContent>
              <Sidebar.Menu>
                {group.pages.map((page) => (
                  <PageLink key={page.href} page={page} current={current?.href === page.href} />
                ))}
              </Sidebar.Menu>
            </Sidebar.GroupContent>
          </Sidebar.Group>
        ))}
      </Sidebar.Content>
      <Sidebar.Footer>
        <Sidebar.Menu>
          {account.map((page) => (
            <PageLink key={page.href} page={page} current={current?.href === page.href} />
          ))}
        </Sidebar.Menu>
      </Sidebar.Footer>
      <Sidebar.Rail />
    </Sidebar.Root>
  );
}
