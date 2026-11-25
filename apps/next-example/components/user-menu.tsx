"use client";
// The user menu at the header's end, ported from Fuse's app-shell block (user-menu.tsx at Fuse 9be80460): who is
// signed in, a link to Settings, the appearance and signing out.
import Link from "next/link";

import { Avatar } from "@elmeragroup/fuse/avatar";
import { Button } from "@elmeragroup/fuse/button";
import { DropdownMenu } from "@elmeragroup/fuse/dropdown-menu";
import { Gear, SignOut } from "@elmeragroup/fuse/icons";
import { COLOR_SCHEMES, useColorScheme } from "@elmeragroup/fuse/theme";
import type { ColorScheme } from "@elmeragroup/fuse/theme";
import { Toast } from "@elmeragroup/fuse/toast";
import type { Descriptor } from "@elmeragroup/intl/core";
import { msg, T, useT, Val } from "@elmeragroup/intl/react";

import { SIGNED_IN } from "../data/signed-in";
import { SIGNED_IN_ROLE } from "../intl/messages";
import { APP_PAGE_BY_ID } from "./app-config";

const SCHEME_LABELS = {
  light: msg("Light", { context: "appearance" }),
  dark: msg("Dark", { context: "appearance" }),
  system: msg("System", { context: "appearance" }),
} as const satisfies Readonly<Record<ColorScheme, Descriptor>>;

// What signing out says. Nodes, not strings: a toast outlives a language switch, and `<T>` renders in the language the
// provider has now.
const SIGNED_OUT_TOAST = {
  title: <T>Signed out</T>,
  description: (
    <T>
      This example has no sign-in, so it opens again as <Val name={SIGNED_IN.firstName} />.
    </T>
  ),
};

/** The signed-in user's avatar and menu. */
export function UserMenu() {
  const t = useT();
  const { colorScheme, setColorScheme } = useColorScheme();
  const toasts = Toast.useToastManager();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("Account menu for {name}", { name: SIGNED_IN.name })}
          />
        }>
        <Avatar.Root className="size-7">
          <Avatar.Fallback>{SIGNED_IN.initials}</Avatar.Fallback>
        </Avatar.Root>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" className="w-60">
        <DropdownMenu.Group>
          <DropdownMenu.Label>
            <span className="text-sm font-medium block text-foreground">{SIGNED_IN.name}</span>
            <span className="text-xs font-normal block truncate">{t.from(SIGNED_IN_ROLE)}</span>
            <span className="text-xs font-normal block truncate">{SIGNED_IN.email}</span>
          </DropdownMenu.Label>
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        {/* A link item stays open on a click unless told otherwise; open, its backdrop would cover the page it led
            to on a phone. The shell moves focus to the new page's title once that page renders, as after any
            navigation. */}
        <DropdownMenu.LinkItem closeOnClick render={<Link href={APP_PAGE_BY_ID.settings.href} />}>
          <Gear />
          {t.from(APP_PAGE_BY_ID.settings.label)}
        </DropdownMenu.LinkItem>
        <DropdownMenu.RadioGroup
          value={colorScheme}
          onValueChange={(value) => {
            const scheme = COLOR_SCHEMES.find((candidate) => candidate === value);
            if (scheme !== undefined) {
              setColorScheme(scheme);
            }
          }}>
          <DropdownMenu.Label>
            <T>Appearance</T>
          </DropdownMenu.Label>
          {COLOR_SCHEMES.map((scheme) => (
            <DropdownMenu.RadioItem key={scheme} value={scheme} closeOnClick={false}>
              {t.from(SCHEME_LABELS[scheme])}
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          onClick={() => {
            toasts.add(SIGNED_OUT_TOAST);
          }}>
          <SignOut />
          <T>Sign out</T>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
