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
export {
  createLocaleSwitcher,
  resolveIntlConfig,
  type LocaleSwitchPort,
  type RequestConfig,
  type RequestLike,
  type ServerAdapter,
  type SwitchOutcome,
} from "./adapter";
export { negotiateLocale, type NegotiateLocaleOptions } from "./negotiate";
