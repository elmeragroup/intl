// Settings: the header and the language section, with the switcher and the form side by side, so a switch keeps the
// form's draft.
import { createFileRoute } from "@tanstack/react-router";

import { Frame } from "@elmeragroup/fuse/frame";
import { T, useT } from "@elmeragroup/intl/react";

import { APP_PAGE_BY_ID } from "../components/app-config";
import { LocaleSwitcher } from "../components/locale-switcher";
import { PageHeader } from "../components/page-header";
import { SettingsForm } from "../components/settings-form";

/** `/settings`: the visitor's profile, language, invoicing defaults and notifications. */
export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const t = useT();
  const page = APP_PAGE_BY_ID.settings;

  return (
    <>
      <PageHeader title={t.from(page.label)} description={t.from(page.description)} />
      <div className="max-w-3xl md:gap-6 md:px-6 flex w-full flex-col gap-4 px-4 pt-2 pb-8">
        <Frame.Root>
          <Frame.Header>
            <Frame.Title>
              <h2 id="language-heading">
                <T>Language</T>
              </h2>
            </Frame.Title>
            <Frame.Description>
              <T>
                The portal's language, here and on every page. Your unsaved changes below stay as they are.
              </T>
            </Frame.Description>
          </Frame.Header>
          <Frame.Panel>
            <LocaleSwitcher />
          </Frame.Panel>
        </Frame.Root>
        <SettingsForm />
      </div>
    </>
  );
}
