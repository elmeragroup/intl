// `@elmeragroup/intl-tools/oxlint`: editor feedback for the extraction contract. The rule runs the extractor itself, so
// lint and `elmera-intl extract` cannot disagree. This module's import graph uses `.ts` specifiers and erasable
// syntax only, so oxlint can load it from source by Node's type stripping. Its `@elmeragroup/intl/internal/message` import
// resolves to the runtime's dist, so `@elmeragroup/intl` is built first.
import type { Plugin, Rule } from "@oxlint/plugins";

import { extractMessages } from "./extract.ts";

const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;

/** Reports every use of the package that extraction cannot resolve, at the source position the extractor names. */
const extractable: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Use @elmeragroup/intl only in forms the extractor can read (see its README)." },
    messages: { notExtractable: "{{message}}" },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const { filename } = context;
        const { text } = context.sourceCode;

        // Every script file: a text pre-filter would let lint pass a file extraction rejects (`i./* c */t("X")`).
        if (!SCRIPT_FILE.test(filename) || DECLARATION_FILE.test(filename)) {
          return;
        }

        const result = extractMessages(filename, text);

        if (result._tag === "Extracted") {
          return;
        }

        for (const failure of result.failures) {
          context.report({
            loc: failure.position,
            messageId: "notExtractable",
            data: { message: failure.message },
          });
        }
      },
    };
  },
};

/**
 * The `elmera-intl` oxlint plugin. Load it from `.oxlintrc.json` (`jsPlugins: [{ "name": "elmera-intl", "specifier":
 * "@elmeragroup/intl-tools/oxlint" }]`) and enable `elmera-intl/extractable`.
 */
const plugin: Plugin = {
  meta: { name: "elmera-intl" },
  rules: { extractable },
};

export default plugin;
