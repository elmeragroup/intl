// The conformance suite's way into the public API: a translator and a provider whose onError fails the test, so a
// message missing from the catalog or failing to format can never pass as a match. Every message goes through
// compileCatalog first, as an app's catalog does: `t` compiles the message it is called with, and a render compiles
// the messages its first pass reports as not extracted, then renders again.
import type { ReactNode } from "react";

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  CreateIntlOptions,
  Descriptor,
  IntlConfig,
  IntlInstance,
  MessageValue,
} from "@elmeragroup/intl/core";
import { createIntl, keyOf } from "@elmeragroup/intl/core";
import { IntlProvider } from "@elmeragroup/intl/react";

import type { Messages } from "../catalogs";
import { compiled } from "../catalogs";

function fail(error: Error, key: string): never {
  throw new Error(`onError for ${JSON.stringify(key)}: ${error.message}`);
}

type Values = Readonly<Record<string, MessageValue>>;

/** A config with its translations (by English source) instead of a catalog; none means every message is English. */
type StrictConfig = Omit<IntlConfig, "catalog"> & { readonly translations?: Messages };

// The catalog of `keys` (untranslated unless `translations` has them) for the config's locale.
function catalogFor(config: StrictConfig, keys: ReadonlyArray<string>) {
  const { locale, formats, translations = {} } = config;

  return compiled(locale, { ...Object.fromEntries(keys.map((key) => [key, ""])), ...translations }, formats);
}

/**
 * `createIntl` with an onError that throws, whose `t` compiles each message into the catalog before translating it.
 *
 * @param config - The translator's config and translations.
 * @returns The translator.
 */
export function strictIntl(config: StrictConfig): IntlInstance {
  const instance = (keys: ReadonlyArray<string>) => {
    const options: CreateIntlOptions = { ...config, catalog: catalogFor(config, keys), onError: fail };

    return createIntl(options);
  };
  const base = instance([]);
  const from = (descriptor: Descriptor, values?: Values) =>
    instance([keyOf(descriptor.message, descriptor.context)]).t.from(descriptor, values);
  // SAFETY: only msg() brands a descriptor, and it takes literals; the runtime reads only message and context, which
  // this object has. The conformance cases call `t` with literals, as next-intl's suite calls its own.
  const translate = (message: string, values?: Values) =>
    from({ message, context: undefined } as Descriptor, values);
  // SAFETY: Translate's call signature and `from` only narrow the message to literals and type `values` from them; at
  // runtime they are these functions, as in createIntl.
  const t = Object.assign(translate, { from }) as IntlInstance["t"];

  return { ...base, t, format: base.format };
}

/**
 * Render a node under `<IntlProvider>` with an onError that throws.
 *
 * @param node - What to render: a `<T>` for a rich-text case.
 * @param config - The provider's config and translations.
 * @returns The static markup.
 */
export function renderStrict(node: ReactNode, config: StrictConfig): string {
  return renderToStaticMarkup(strictTree(node, config));
}

/**
 * Mount a node through `createRoot` under `<IntlProvider>` with an onError that throws. Client rendering, unlike
 * `renderStrict`, reconciles children, so React's duplicate-key warning can fire. Needs a DOM (jsdom).
 *
 * @param node - What to render: a `<T>` for a rich-text case.
 * @param config - The provider's config and translations.
 * @returns The mounted markup.
 */
export function mountStrict(node: ReactNode, config: StrictConfig): string {
  const container = document.createElement("div");
  const root = createRoot(container);
  // flushSync commits synchronously without act, which would need IS_REACT_ACT_ENVIRONMENT.
  flushSync(() => {
    root.render(strictTree(node, config));
  });
  const html = container.innerHTML;
  root.unmount();

  return html;
}

// The keys the node's messages report as not extracted: what an app's extractor would have put in the catalog.
function extractedBy(node: ReactNode, config: StrictConfig): ReadonlyArray<string> {
  const keys: Array<string> = [];
  renderToStaticMarkup(
    <IntlProvider
      locale={config.locale}
      timeZone={config.timeZone}
      formats={config.formats}
      catalog={catalogFor(config, [])}
      onError={(error, key) => {
        if ("_tag" in error && error._tag === "MessageNotExtracted") {
          keys.push(key);
        }
      }}>
      {node}
    </IntlProvider>
  );

  return keys;
}

function strictTree(node: ReactNode, config: StrictConfig) {
  const { locale, timeZone, formats } = config;

  return (
    <IntlProvider
      locale={locale}
      timeZone={timeZone}
      formats={formats}
      catalog={catalogFor(config, extractedBy(node, config))}
      onError={fail}>
      {node}
    </IntlProvider>
  );
}
