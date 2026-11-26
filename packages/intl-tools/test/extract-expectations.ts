// The extraction tests' shared oracle: the package specifier and the hand-written failure texts more than one test file
// asserts, so each is written out once.

export const PKG = "@elmeragroup/intl";

export const UNTRACED_INTL = (receiver: string) =>
  `cannot trace \`${receiver}\` to useIntl(), getIntl(), createIntl() or \`yield* CurrentIntl\` in this file, so \`.t(…)\` on it is not extracted; bind the IntlInstance here, or translate a msg() descriptor with \`.t.from\``;
export const UNTRACED_T =
  "cannot trace `t` to useT() or getT(), or to the `.t` of an IntlInstance from useIntl(), getIntl(), createIntl() or `yield* CurrentIntl`, in this file, so `t(…)` is not extracted; bind it here (`const t = useT()`, `const t = await getT()`, or an instance's `const { t } = await getIntl()`), or translate `msg()` descriptors with `t.from(descriptor)` / `.t.from`";

export const NOT_BOUND =
  '`{ t }` destructured from something that is not a bound IntlInstance; call `.t("…")` on an IntlInstance bound in this file';

// What an IntlInstance used as a value is told, naming the expression by the form it is written in.
export const AS_VALUE = (form: string) =>
  `\`${form}\` is an IntlInstance (or a promise of one) used as a value, not through its own members, so wherever it goes its \`t\` is not extracted; bind one where it is used (\`useT()\` or \`useIntl()\` in the child, \`await getIntl()\`, \`yield* CurrentIntl\` provided by \`CurrentIntl.layer(options)\` or \`CurrentIntl.provide(effect)\`, or \`createIntl(config)\` with the config passed), or pass \`msg()\` descriptors, its \`format\` or its \`locale\``;

// What a file that does not import the package is told when its `t` comes from an app module: the base text, the
// module, and the migration advice only such a file gets.
export const APP_T = (specifier: string) =>
  `cannot trace \`t\` to useT() or getT(), or to the \`.t\` of an IntlInstance from useIntl(), getIntl(), createIntl() or \`yield* CurrentIntl\`, in this file; it comes from \`${specifier}\`, so \`t(…)\` is not extracted; bind it here (\`const t = useT()\`, \`const t = await getT()\`, or an instance's \`const { t } = await getIntl()\`), or translate \`msg()\` descriptors with \`t.from(descriptor)\` / \`.t.from\`. If this \`t\` is another library's translator (an app module wrapping it while the app migrates), rename it in this file, or, if this file's only i18n is this legacy translator, list this file in \`exclude\` and turn \`elmera-intl/extractable\` off for it (see the README's migration section)`;
// What a file that imports the package is told: no exclusion or rename advice, since either would lose its intl checks,
// and a split file still needs a legacy-only remedy.
export const APP_T_IMPORTING = (specifier: string) =>
  `cannot trace \`t\` to useT() or getT(), or to the \`.t\` of an IntlInstance from useIntl(), getIntl(), createIntl() or \`yield* CurrentIntl\`, in this file; it comes from \`${specifier}\`, so \`t(…)\` is not extracted; bind it here (\`const t = useT()\`, \`const t = await getT()\`, or an instance's \`const { t } = await getIntl()\`), or translate \`msg()\` descriptors with \`t.from(descriptor)\` / \`.t.from\`. If this \`t\` is another library's translator, have its module expose it under another name, or move the code that uses it to a file without the intl package and give that file a legacy-only remedy too (see the README's migration section)`;

export const NOT_YIELDED =
  "`CurrentIntl` is only read with `yield* CurrentIntl` and provided with `.layer(…)` or `.provide(…)`, so extraction sees every translator; read the translator with `const { t } = yield* CurrentIntl`";
