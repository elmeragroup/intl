/** The elements an MDX page's Markdown renders to, by tag: none restyled yet. */
type MdxComponents = Readonly<Record<string, never>>;

/**
 * The elements every MDX docs page renders its Markdown with, which `@next/mdx` reads from this file by name. A page's
 * title is not Markdown: it renders from its entry in the page list (src/lib/pages.ts).
 *
 * @returns The element for each Markdown tag the docs style.
 */
export function useMDXComponents(): MdxComponents {
  return {};
}
