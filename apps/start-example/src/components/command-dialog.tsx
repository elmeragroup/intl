// The command menu's dialog, ported from Fuse's app-shell block (command-menu.tsx at Fuse 9be80460): it goes to every
// page and runs the app's actions, and it matches every word typed against each command's name and keywords, both in
// the visitor's language. The header's search button (src/components/command-menu.tsx) loads this module the first
// time the menu opens, so Fuse's command palette stays out of the code every page loads first.
import { useEffect, useMemo, useRef } from "react";
import type { ComponentType } from "react";

import { useLocation, useNavigate } from "@tanstack/react-router";

import { Command } from "@elmeragroup/fuse/command";
import { Link as LinkIcon, Moon, SidebarSimple, Sun } from "@elmeragroup/fuse/icons";
import type { ElmeraIconProps } from "@elmeragroup/fuse/icons";
import { Kbd } from "@elmeragroup/fuse/kbd";
import { useSidebar } from "@elmeragroup/fuse/sidebar";
import { useColorScheme } from "@elmeragroup/fuse/theme";
import { Toast } from "@elmeragroup/fuse/toast";
import { msg, T, useIntl, useT } from "@elmeragroup/intl/react";

import { APP_PAGES } from "./app-config";
import { useApplePlatform } from "./use-apple-platform";

type MenuCommand = {
  readonly id: string;
  readonly label: string;
  readonly keywords: string;
  readonly icon: ComponentType<ElmeraIconProps>;
  /** The keys that run it without the menu, as its row shows them. */
  readonly keys?: ReadonlyArray<string>;
  /** The route a page command opens; actions stay on the page. */
  readonly route?: string;
  readonly run: () => void;
};

type MenuGroup = {
  readonly value: "pages" | "actions";
  readonly label: string;
  readonly items: ReadonlyArray<MenuCommand>;
};

// The extra words each action matches, as a translator would search for them.
const ACTION_KEYWORDS = {
  sidebar: msg("collapse expand navigation", { context: "search words" }),
  appearance: msg("theme color scheme mode", { context: "search words" }),
  link: msg("url share address", { context: "search words" }),
} as const;

// Copies the page's address, and says whether it did. The Clipboard API exists only in a secure context: on a plain-HTTP
// origin, such as the app opened by its address on the local network, `navigator.clipboard` is undefined, though the
// DOM's types say otherwise, and reading `writeText` from it throws. Either failure is an answer, never an exception.
function copyPageLink(): Promise<boolean> {
  try {
    return navigator.clipboard.writeText(window.location.href).then(
      () => true,
      () => false
    );
  } catch {
    return Promise.resolve(false);
  }
}

// Whether a command's name or keywords hold every word of the query, compared in the page's language.
function matches(command: MenuCommand, query: string, locale: string): boolean {
  const haystack = `${command.label} ${command.keywords}`.toLocaleLowerCase(locale);

  return query
    .toLocaleLowerCase(locale)
    .split(/\s+/u)
    .every((word) => haystack.includes(word));
}

function useCommands(): ReadonlyArray<MenuGroup> {
  const t = useT();
  const navigate = useNavigate();
  const { toggleSidebar } = useSidebar();
  const { resolvedColorScheme, setColorScheme } = useColorScheme();
  const toasts = Toast.useToastManager();
  const apple = useApplePlatform();

  return useMemo(() => {
    const dark = resolvedColorScheme === "dark";

    return [
      {
        value: "pages",
        label: t("Pages"),
        items: APP_PAGES.map((page) => ({
          id: `page:${page.href}`,
          label: t.from(page.label),
          keywords: t.from(page.keywords),
          icon: page.icon,
          route: page.href,
          run: () => {
            void navigate({ to: page.href });
          },
        })),
      },
      {
        value: "actions",
        label: t("Actions"),
        items: [
          {
            id: "toggle-sidebar",
            label: t("Toggle sidebar"),
            keywords: t.from(ACTION_KEYWORDS.sidebar),
            icon: SidebarSimple,
            keys: [apple ? "⌘" : "Ctrl", "B"],
            run: toggleSidebar,
          },
          {
            id: "appearance",
            label: dark ? t("Switch to light appearance") : t("Switch to dark appearance"),
            keywords: t.from(ACTION_KEYWORDS.appearance),
            icon: dark ? Sun : Moon,
            run: () => {
              setColorScheme(dark ? "light" : "dark");
            },
          },
          {
            id: "copy-link",
            label: t("Copy link to this page"),
            keywords: t.from(ACTION_KEYWORDS.link),
            icon: LinkIcon,
            run: () => {
              // Nodes, not strings: a toast outlives a language switch, and `<T>` follows the provider.
              void copyPageLink().then((copied) =>
                copied
                  ? toasts.add({ type: "success", title: <T>Link copied</T> })
                  : toasts.add({ type: "error", title: <T>Could not copy the link</T> })
              );
            },
          },
        ],
      },
    ];
  }, [t, navigate, toggleSidebar, resolvedColorScheme, setColorScheme, toasts, apple]);
}

/** What the header's search button passes the dialog. */
export type CommandDialogProps = {
  /** Whether the menu is open. */
  readonly open: boolean;
  /** Called when the menu opens or closes itself. */
  readonly onOpenChange: (open: boolean) => void;
};

/**
 * The command menu's dialog, open or closed as the header's search button and ⌘K say.
 *
 * @param props - Whether the menu is open, and what to call when it opens or closes itself.
 */
export function CommandDialog({ open, onOpenChange }: CommandDialogProps) {
  const t = useT();
  const { locale } = useIntl();
  const groups = useCommands();
  const pathname = useLocation({ select: (location) => location.pathname });
  // Whether the last command left for another page. The shell then focuses the new page's title, so the closing menu
  // must not hand focus back to the search button in the header.
  const leaving = useRef(false);

  // Each opening starts on the page it opened on, however it opened: the search button or ⌘K.
  useEffect(() => {
    if (open) {
      leaving.current = false;
    }
  }, [open]);

  return (
    <Command.Root
      grouped
      items={groups}
      itemToStringValue={(command) => command.label}
      filter={(command, query) => matches(command, query, locale)}
      open={open}
      onOpenChange={onOpenChange}>
      <Command.Content finalFocus={() => !leaving.current}>
        <Command.Input
          aria-label={t("Search pages and actions")}
          placeholder={t("Search pages and actions")}
        />
        <Command.Empty>
          <T>No page or action matches.</T>
        </Command.Empty>
        <Command.List>
          {(group: MenuGroup) => (
            <Command.Group key={group.value} items={group.items}>
              <Command.Label>{group.label}</Command.Label>
              <Command.Collection>
                {(command: MenuCommand) => {
                  const Icon = command.icon;

                  return (
                    <Command.Item
                      key={command.id}
                      value={command}
                      onClick={() => {
                        leaving.current = command.route !== undefined && command.route !== pathname;
                        onOpenChange(false);
                        command.run();
                      }}>
                      <Icon />
                      {command.label}
                      {command.keys === undefined ? null : (
                        <Command.Shortcut>
                          {command.keys.map((key) => (
                            <Kbd key={key}>{key}</Kbd>
                          ))}
                        </Command.Shortcut>
                      )}
                    </Command.Item>
                  );
                }}
              </Command.Collection>
            </Command.Group>
          )}
        </Command.List>
        <Command.Footer>
          <Command.NavigateHint />
          <Command.SelectHint />
          <Command.CloseHint />
        </Command.Footer>
      </Command.Content>
    </Command.Root>
  );
}
