// The package speaks intl, never i18n, and never declares `Intl`: a type or value named `Intl` shadows the global in
// every file that imports it (`new Intl.NumberFormat` stops compiling), so the instance type is `IntlInstance`.
import type { ESTree, Rule } from "@oxlint/plugins";

import { boundIdentifiers } from "../ast.ts";

const FOREIGN_VOCABULARY = /i18n/iu;

/** Reports a declared name that spells i18n, or that is exactly `Intl`. */
export const vocabulary: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Declare names in the intl vocabulary: no i18n, and no binding named Intl." },
    messages: {
      i18n: "`{{name}}` spells i18n; this package's vocabulary is intl (createIntl, IntlInstance, useIntl): rename it.",
      shadowsIntl:
        "`Intl` shadows the global Intl (`new Intl.NumberFormat` stops compiling where it is in scope): name the instance type IntlInstance and a variable holding one `intl`.",
    },
    schema: [],
  },
  create(context) {
    function check(identifier: { readonly name: string } & ESTree.Span): void {
      if (identifier.name === "Intl") {
        context.report({ node: identifier, messageId: "shadowsIntl" });
      } else if (FOREIGN_VOCABULARY.test(identifier.name)) {
        context.report({ node: identifier, messageId: "i18n", data: { name: identifier.name } });
      }
    }

    function checkPattern(pattern: ESTree.Node | null): void {
      for (const identifier of boundIdentifiers(pattern)) {
        check(identifier);
      }
    }

    function checkFunction(node: ESTree.Function | ESTree.ArrowFunctionExpression): void {
      if (node.type !== "ArrowFunctionExpression" && node.id) {
        check(node.id);
      }

      for (const parameter of node.params) {
        checkPattern(parameter);
      }
    }

    return {
      VariableDeclarator: (node) => checkPattern(node.id),
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
      CatchClause: (node) => checkPattern(node.param),
      ClassDeclaration: (node) => node.id && check(node.id),
      ClassExpression: (node) => node.id && check(node.id),
      TSTypeAliasDeclaration: (node) => check(node.id),
      TSInterfaceDeclaration: (node) => check(node.id),
      TSEnumDeclaration: (node) => check(node.id),
      TSTypeParameter: (node) => check(node.name),
      ImportSpecifier: (node) => check(node.local),
      ImportDefaultSpecifier: (node) => check(node.local),
      ImportNamespaceSpecifier: (node) => check(node.local),
      ExportSpecifier: (node) => node.exported.type === "Identifier" && check(node.exported),
    };
  },
};
