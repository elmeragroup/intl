// Readers for the JSONC and YAML configs the manifest test checks: real parsers, and the comments around a node read
// from the parser's offsets, never from line patterns.
import type { Node, ParseError } from "jsonc-parser";
import { findNodeAtLocation, getNodeValue, parse, parseTree, printParseErrorCode, visit } from "jsonc-parser";
import { parse as parseYaml } from "yaml";

const JSONC_OPTIONS = { allowTrailingComma: true, disallowComments: false };

/**
 * Parse JSON with comments and trailing commas, as tsconfig and `.oxlintrc.json` are written.
 *
 * @param text - The file's text.
 * @returns The parsed value.
 * @throws When the text is not valid JSONC: a committed config that does not parse is a defect of the checkout.
 */
export function parseJsonc(text: string): unknown {
  const errors: Array<ParseError> = [];
  const value: unknown = parse(text, errors, JSONC_OPTIONS);

  if (errors.length > 0) {
    throw new Error(
      errors.map((error) => `${printParseErrorCode(error.error)} at ${error.offset}`).join(", ")
    );
  }

  return value;
}

/** A rule's top-level setting in `.oxlintrc.json`: its level and the options that follow it. */
export type RuleSetting = {
  /** The level, `"error"` or `"off"` as the conventions allow, or whatever else is written there. */
  readonly level: unknown;
  /** The options after the level, as oxlint passes them to the rule (`[]` for a bare level). */
  readonly options: ReadonlyArray<unknown>;
};

/**
 * A rule's setting in `.oxlintrc.json`'s top-level `rules`.
 *
 * @param text - The file's text.
 * @param id - The rule id, such as `elmera-workspace/file-copies`.
 * @returns Its level and options, or `undefined` when the rule is not set there.
 */
export function ruleSetting(text: string, id: string): RuleSetting | undefined {
  const root = parseTree(text, [], JSONC_OPTIONS);
  const node = root === undefined ? undefined : findNodeAtLocation(root, ["rules", id]);

  if (node === undefined) {
    return undefined;
  }

  const value: unknown = getNodeValue(node);

  return Array.isArray(value) ? { level: value[0], options: value.slice(1) } : { level: value, options: [] };
}

/** One `name: version` entry of the pnpm catalogs. */
export type CatalogEntry = { readonly name: string; readonly version: string };

function entriesOf(section: unknown): ReadonlyArray<CatalogEntry> {
  return typeof section === "object" && section !== null
    ? Object.entries(section).map(([name, version]) => ({ name, version: String(version) }))
    : [];
}

/**
 * Every entry of `pnpm-workspace.yaml`'s default `catalog` and its named `catalogs`.
 *
 * @param yaml - The file's text.
 * @returns The entries, the default catalog first.
 */
export function catalogEntries(yaml: string): ReadonlyArray<CatalogEntry> {
  const document: unknown = parseYaml(yaml);

  if (typeof document !== "object" || document === null) {
    return [];
  }

  const named = "catalogs" in document ? document.catalogs : undefined;

  return [
    ...entriesOf("catalog" in document ? document.catalog : undefined),
    ...(typeof named === "object" && named !== null
      ? Object.values(named).flatMap((section) => entriesOf(section))
      : []),
  ];
}

/** What the manifest test asks of `.oxlintrc.json`, as rule ids and override file lists that break it. */
export type LintConfigFindings = {
  /** Rules (and categories) configured `warn`. */
  readonly warned: ReadonlyArray<string>;
  /** Rules turned off with no comment naming the contract: above them, above their run of offs, or on the override. */
  readonly unexplainedOffs: ReadonlyArray<string>;
  /** File-scoped overrides (paths, no glob) with no comment above them. */
  readonly unexplainedOverrides: ReadonlyArray<string>;
};

function severity(value: Node | undefined): unknown {
  if (value === undefined) {
    return undefined;
  }

  const raw: unknown = getNodeValue(value);

  return Array.isArray(raw) ? raw[0] : raw;
}

function property(object: Node | undefined, key: string): Node | undefined {
  return object?.children?.find((child) => child.children?.[0]?.value === key)?.children?.[1];
}

// A JSONC document's tree, and whether a comment explains a node: it sits between the node and whatever precedes it in
// its container.
function parseWithComments(text: string) {
  const comments: Array<{ readonly start: number; readonly end: number }> = [];

  visit(
    text,
    { onComment: (offset, length) => comments.push({ start: offset, end: offset + length }) },
    JSONC_OPTIONS
  );

  return {
    root: parseTree(text, [], JSONC_OPTIONS),
    commentedBefore: (nodes: ReadonlyArray<Node>, index: number, container: Node): boolean => {
      const from =
        index === 0 ? container.offset : (nodes[index - 1]?.offset ?? 0) + (nodes[index - 1]?.length ?? 0);
      const to = nodes[index]?.offset ?? 0;

      return comments.some((comment) => comment.start >= from && comment.end <= to);
    },
  };
}

// Each rule of a map of severities with its level, and for a rule turned off whether a comment explains it: one above
// the rule or above its run of offs.
function ruleLevels(
  rules: Node | undefined,
  commentedBefore: ReturnType<typeof parseWithComments>["commentedBefore"]
) {
  const entries = rules?.children ?? [];

  return entries.map((entry, index) => {
    const id = String(entry.children?.[0]?.value);
    const level = severity(entry.children?.[1]);

    if (level !== "off" || rules === undefined) {
      return { id, level, commented: false };
    }

    let first = index;

    while (first > 0 && severity(entries[first - 1]?.children?.[1]) === "off") {
      first -= 1;
    }

    return { id, level, commented: commentedBefore(entries, first, rules) };
  });
}

/** What the manifest test asks of a map of rule severities, as the rule names that break it. */
export type SeverityFindings = {
  /** Rules at a level other than `error` and `off`. */
  readonly unclear: ReadonlyArray<string>;
  /** Rules turned off with no comment above them or above their run of offs. */
  readonly unexplainedOffs: ReadonlyArray<string>;
};

/**
 * Check the Effect language service's severities in a tsconfig preset (`compilerOptions.plugins[0]`): every rule is
 * an error or off, and every off carries its comment, as `.oxlintrc.json`'s rules do.
 *
 * @param text - The preset's text.
 * @returns The findings; every list is empty for a preset that meets the conventions.
 */
export function effectPresetFindings(text: string): SeverityFindings {
  const { root, commentedBefore } = parseWithComments(text);
  const rules =
    root === undefined
      ? undefined
      : findNodeAtLocation(root, ["compilerOptions", "plugins", 0, "diagnosticSeverity"]);
  const levels = ruleLevels(rules, commentedBefore);

  return {
    unclear: levels.filter(({ level }) => level !== "error" && level !== "off").map(({ id }) => id),
    unexplainedOffs: levels
      .filter(({ level, commented }) => level === "off" && !commented)
      .map(({ id }) => id),
  };
}

/**
 * Check `.oxlintrc.json`'s severities and the comments its exceptions carry.
 *
 * @param text - The file's text.
 * @returns The findings; every list is empty for a config that meets the conventions.
 */
export function lintConfigFindings(text: string): LintConfigFindings {
  const { root, commentedBefore } = parseWithComments(text);
  const warned: Array<string> = [];
  const unexplainedOffs: Array<string> = [];
  const unexplainedOverrides: Array<string> = [];

  const checkRules = (rules: Node | undefined, explainedByOverride: boolean | undefined): void => {
    for (const { id, level, commented } of ruleLevels(rules, commentedBefore)) {
      if (level === "warn") {
        warned.push(id);
      }

      if (level === "off" && !(explainedByOverride ?? commented)) {
        unexplainedOffs.push(id);
      }
    }
  };

  for (const category of property(root, "categories")?.children ?? []) {
    if (severity(category.children?.[1]) === "warn") {
      warned.push(String(category.children?.[0]?.value));
    }
  }

  checkRules(property(root, "rules"), undefined);

  const overridesNode = property(root, "overrides");
  const overrides = overridesNode?.children ?? [];

  overrides.forEach((override, index) => {
    const explained = overridesNode !== undefined && commentedBefore(overrides, index, overridesNode);
    const files: unknown = getNodeValue(property(override, "files") ?? override);
    const paths = Array.isArray(files) ? files.map(String) : [];

    if (!explained && paths.length > 0 && paths.every((path) => !path.includes("*"))) {
      unexplainedOverrides.push(paths.join(", "));
    }

    checkRules(property(override, "rules"), explained);
  });

  return { warned, unexplainedOffs, unexplainedOverrides };
}
