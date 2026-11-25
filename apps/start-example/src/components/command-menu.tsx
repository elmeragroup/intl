// The command menu's search button in the header, ported from Fuse's app-shell block (command-menu.tsx at Fuse
// 9be80460): ⌘K or Ctrl+K anywhere in the app, or the button, opens the menu. The menu itself
// (src/components/command-dialog.tsx), Fuse's command palette with every command in it, loads on the first opening:
// most visits never open it, and the code every page loads first stays without it.
import { useEffect, useState } from "react";
import type { ComponentType } from "react";

import { useHydrated } from "@tanstack/react-router";

import { Button } from "@elmeragroup/fuse/button";
import { MagnifyingGlass } from "@elmeragroup/fuse/icons";
import { Kbd, KbdGroup } from "@elmeragroup/fuse/kbd";
import { Toast } from "@elmeragroup/fuse/toast";
import { T, useT } from "@elmeragroup/intl/react";

import type { CommandDialogProps } from "./command-dialog";
import { useApplePlatform } from "./use-apple-platform";

// Where the dialog's code is: not asked for yet, on its way, here, or failed to arrive. A failed download stays failed
// until the page reloads: a browser may keep a module whose fetch failed under its URL and answer every later import of
// it with the same failure (WebKit does), so asking again in place is no retry.
type DialogCode =
  | { readonly _tag: "Unloaded" }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Loaded"; readonly Dialog: ComponentType<CommandDialogProps> }
  | { readonly _tag: "Failed" };

/** The header's search button and the command menu it opens. */
export function CommandMenu() {
  const t = useT();
  const apple = useApplePlatform();
  const hydrated = useHydrated();
  const toasts = Toast.useToastManager();
  const [open, setOpen] = useState(false);
  // The dialog's code; once it has arrived, the dialog stays mounted, open or not.
  const [code, setCode] = useState<DialogCode>({ _tag: "Unloaded" });

  // Asks for the dialog's code on the first opening. React.lazy would keep a failed download (the network dropped, or
  // a deploy replaced the chunk) and throw it to the app's error boundary, taking the page down with the menu: here the
  // rejected import is an answer, a translated notice whose action reloads the page, and the page stays mounted. Every
  // opening after a failure says so again.
  useEffect(() => {
    if (!open) {
      return;
    }
    switch (code._tag) {
      case "Loading":
      case "Loaded":
        return;
      case "Unloaded":
        setCode({ _tag: "Loading" });
        import("./command-dialog").then(
          ({ CommandDialog }) => {
            setCode({ _tag: "Loaded", Dialog: CommandDialog });
          },
          () => {
            setCode({ _tag: "Failed" });
          }
        );
        return;
      case "Failed":
        setOpen(false);
        // Nodes, not strings: the notice outlives a language switch, and `<T>` follows the provider.
        toasts.add({
          type: "error",
          title: <T>Search is unavailable</T>,
          actionProps: {
            children: <T>Reload page</T>,
            onClick: () => {
              window.location.reload();
            },
          },
        });
    }
  }, [open, code, toasts]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        aria-label={t("Search")}
        aria-keyshortcuts="Meta+K Control+K"
        aria-haspopup="dialog"
        aria-expanded={open}
        // Enabled once React has hydrated the shell: a click before then would open nothing.
        disabled={!hydrated}
        className="sm:w-56 sm:justify-start"
        onClick={() => {
          setOpen(true);
        }}>
        <MagnifyingGlass data-icon="inline-start" />
        <span className="sm:inline hidden">
          <T>Search…</T>
        </span>
        <KbdGroup className="sm:inline-flex ml-auto hidden">
          <Kbd>{apple ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </Button>
      {/* Nothing shows while the dialog's code loads: the menu opens as it arrives. */}
      {code._tag === "Loaded" ? <code.Dialog open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}
