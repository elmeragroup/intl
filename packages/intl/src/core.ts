// `@elmeragroup/intl/core`: platform-neutral, no React. Message identity, the translator and the adapter contract.
export { keyOf, serialize, SERIALIZER_VERSION, type MessageNode } from "./message";
export {
  createIntl,
  msg,
  type Catalog,
  type CreateIntlOptions,
  type Descriptor,
  type Format,
  type Formats,
  type IntlInstance,
  type IntlConfig,
  type MessageOptions,
  type MessageValue,
  type RelativeTimeOptions,
  type Translate,
} from "./intl";
export { resolveIntlConfig, type RequestConfig, type RequestLike, type ServerAdapter } from "./adapter";
export { createLocaleSwitcher, type LocaleSwitchPort, type SwitchOutcome } from "./locale-switch";
export { negotiateLocale, type NegotiateLocaleOptions } from "./negotiate";
