// Settings, ported from Fuse's app-shell block (settings-page.tsx at Fuse 9be80460): one form in three sections, each
// field wired to its label, description and error by Fuse's Field. Every field lives in one draft; Save parses the
// whole draft, and the server function saves it and says what it set, in the visitor's language. Discard returns the
// draft to what was last saved. A field that does not parse shows the reason and takes focus.
//
// The draft is client state: a language switch beside it (components/locale-switcher.tsx) re-renders every label in
// place and keeps what the visitor typed, and so does a save: the visitor can type on while one is in flight. It lives
// above the page (src/components/settings-draft.tsx), so a failed reload after a switch, which unmounts the form, keeps
// it too.
import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { useHydrated } from "@tanstack/react-router";

import { Button } from "@elmeragroup/fuse/button";
import { Field } from "@elmeragroup/fuse/field";
import { Frame } from "@elmeragroup/fuse/frame";
import { Radio, RadioGroup } from "@elmeragroup/fuse/radio-group";
import { Select } from "@elmeragroup/fuse/select";
import { SelectField } from "@elmeragroup/fuse/select-field";
import { Switch } from "@elmeragroup/fuse/switch";
import { TextField } from "@elmeragroup/fuse/text-field";
import type { Descriptor } from "@elmeragroup/intl/core";
import { msg, T, useIntl, useT } from "@elmeragroup/intl/react";

import { CONTRACT_TYPES } from "../data/market";
import { isUnchanged, parseSettings, PAYMENT_TERMS, settingsErrors } from "../data/settings";
import type { SettingsField } from "../data/settings";
import { CONTRACT_LABELS } from "../intl/messages";
import { saveSettings } from "../server/portal.functions";
import { answered, AnswerRequest, FAILED, UNASKED } from "./answer-request";
import type { Answer } from "./answer-request";
import { useSettingsDraft } from "./settings-draft";

// What is wrong with each field that does not parse.
const FIELD_ERRORS = {
  name: msg("Enter your name."),
  email: msg("Enter an email address such as name@example.com."),
  threshold: msg("Enter a whole number of øre from 1 to 999."),
} as const satisfies Readonly<Record<SettingsField, Descriptor>>;

// The API route's answer: a non-2xx status is a failure, whatever its body says; so is a request that never got a
// response.
async function fetchTestAlert(): Promise<Answer> {
  try {
    const response = await fetch("/api/greeting");

    return response.ok ? answered(await response.text()) : FAILED;
  } catch {
    return FAILED;
  }
}

function Section({
  title,
  description,
  children,
}: {
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Frame.Root>
      <Frame.Header>
        <Frame.Title>
          <h2>{title}</h2>
        </Frame.Title>
        <Frame.Description>{description}</Frame.Description>
      </Frame.Header>
      <Frame.Panel>
        <div className="flex flex-col gap-5">{children}</div>
      </Frame.Panel>
    </Frame.Root>
  );
}

/** The settings form, its save and the API route's test alert. */
export function SettingsForm() {
  const t = useT();
  const { locale } = useIntl();
  // The fields take input once React has hydrated the form: text typed into the server's HTML before then would be
  // lost when React takes the inputs over.
  const hydrated = useHydrated();
  const form = useRef<HTMLFormElement>(null);
  const { saved, draft, edit, discard, startSave } = useSettingsDraft();
  // Whether the form marks what does not parse: from the first Save that found a field to fix, until a save goes out or
  // the draft is discarded. What it marks is the draft as it stands, so a field fixed since, or a threshold whose alerts
  // were turned off, is no longer marked.
  const [errorDisplay, setErrorDisplay] = useState<"Hidden" | "Shown">("Hidden");
  const errors = errorDisplay === "Shown" ? settingsErrors(draft) : [];
  const unchanged = isUnchanged(draft, saved);

  function errorOf(field: SettingsField): string | undefined {
    return errors.includes(field) ? t.from(FIELD_ERRORS[field]) : undefined;
  }

  // Parses the whole draft. A field that does not parse shows why and takes focus, which reads its error as it lands;
  // a draft that parses goes to the server, and what the server saved becomes the form's saved state. The visitor may
  // edit while the save is in flight: the draft then keeps their edits, and only a draft still as it was sent takes the
  // saved values' form (a trimmed name, say).
  function save(): Promise<Answer> {
    const parsed = parseSettings(draft);

    if (parsed._tag === "err") {
      setErrorDisplay("Shown");
      const first = parsed.errors[0];
      const control = first === undefined ? null : form.current?.elements.namedItem(first);
      if (control instanceof HTMLElement) {
        control.focus();
      }

      return Promise.resolve(UNASKED);
    }

    setErrorDisplay("Hidden");
    const settle = startSave(draft);

    return saveSettings({ data: draft }).then(
      (outcome) => {
        if (outcome._tag === "Saved") {
          settle(outcome.settings);
        }

        return answered(outcome.message);
      },
      () => FAILED
    );
  }

  const contractItems = Object.fromEntries(
    CONTRACT_TYPES.map((contract) => [contract, t.from(CONTRACT_LABELS[contract])])
  );

  return (
    // The form parses its own draft, so the browser's own validation stands aside; Save's click does the saving.
    <form
      ref={form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
      }}
      className="max-w-3xl md:gap-6 flex w-full flex-col gap-4">
      <Section
        title={<T>Profile</T>}
        description={<T>How you appear to your team, and where your mail goes.</T>}>
        <TextField
          label={t("Full name")}
          name="name"
          value={draft.name}
          onChange={(name) => {
            edit({ name });
          }}
          isRequired
          isDisabled={!hydrated}
          isInvalid={errors.includes("name")}
          errorMessage={errorOf("name")}
        />
        <TextField
          label={t("Email")}
          name="email"
          value={draft.email}
          onChange={(email) => {
            edit({ email });
          }}
          description={t("Reports and price alerts go here.")}
          isRequired
          isDisabled={!hydrated}
          isInvalid={errors.includes("email")}
          errorMessage={errorOf("email")}
        />
      </Section>

      <Section
        title={<T>Invoicing</T>}
        description={<T>The defaults for customers who sign up from today.</T>}>
        <SelectField
          label={t("Default contract")}
          name="contract"
          items={contractItems}
          value={draft.defaultContract}
          onValueChange={(value) => {
            const contract = CONTRACT_TYPES.find((candidate) => candidate === value);
            if (contract !== undefined) {
              edit({ defaultContract: contract });
            }
          }}
          description={t("Customers can change contract at any time.")}
          isDisabled={!hydrated}>
          {CONTRACT_TYPES.map((contract) => (
            <Select.Item key={contract} value={contract}>
              {t.from(CONTRACT_LABELS[contract])}
            </Select.Item>
          ))}
        </SelectField>
        <RadioGroup
          label={t("Payment terms")}
          description={t("How long a new customer has to pay each invoice.")}
          name="terms"
          orientation="horizontal"
          isDisabled={!hydrated}
          value={String(draft.paymentTerms)}
          onChange={(value) => {
            const terms = PAYMENT_TERMS.find((days) => String(days) === value);
            if (terms !== undefined) {
              edit({ paymentTerms: terms });
            }
          }}>
          {PAYMENT_TERMS.map((days) => (
            <Radio key={days} value={String(days)}>
              {t("{days, plural, one {# day} other {# days}}", { days })}
            </Radio>
          ))}
        </RadioGroup>
      </Section>

      <Section title={<T>Notifications</T>} description={<T>What we tell you about, and when.</T>}>
        <Field.Root orientation="horizontal" className="justify-between">
          <Field.Content>
            <Field.Label>
              <T>Price alerts</T>
            </Field.Label>
            <Field.Description>
              <T>Mail me when NO1's spot price passes the threshold.</T>
            </Field.Description>
          </Field.Content>
          <Switch
            name="priceAlerts"
            checked={draft.alertsOn}
            disabled={!hydrated}
            onCheckedChange={(alertsOn) => {
              edit({ alertsOn });
            }}
          />
        </Field.Root>
        <TextField
          label={t("Alert threshold, øre/kWh")}
          name="threshold"
          filter="numeric"
          value={draft.threshold}
          onChange={(threshold) => {
            edit({ threshold });
          }}
          isDisabled={!hydrated || !draft.alertsOn}
          isInvalid={errors.includes("threshold")}
          errorMessage={errorOf("threshold")}
        />
        <Field.Root orientation="horizontal" className="justify-between">
          <Field.Content>
            <Field.Label>
              <T>Weekly report</T>
            </Field.Label>
            <Field.Description>
              <T>The portfolio's consumption and invoicing, every Monday.</T>
            </Field.Description>
          </Field.Content>
          <Switch
            name="weeklyReport"
            checked={draft.weeklyReport}
            disabled={!hydrated}
            onCheckedChange={(weeklyReport) => {
              edit({ weeklyReport });
            }}
          />
        </Field.Root>
        {/* The API route translates the alert's text. */}
        <AnswerRequest key={locale} id="api-greeting" ask={fetchTestAlert}>
          <T>Send a test alert</T>
        </AnswerRequest>
      </Section>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <p role="status" id="settings-state" className="text-sm mr-auto text-muted-foreground">
          {unchanged ? <T>All changes saved</T> : <T>Unsaved changes</T>}
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={unchanged}
          onClick={() => {
            discard();
            setErrorDisplay("Hidden");
          }}>
          <T>Discard changes</T>
        </Button>
        <AnswerRequest key={locale} id="settings-saved" ask={save} submit="yes">
          <T>Save settings</T>
        </AnswerRequest>
      </div>
    </form>
  );
}
