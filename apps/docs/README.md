# Docs site

The documentation site for `@elmeragroup/intl` and `@elmeragroup/intl-tools`: a Next.js App Router
app on Elmera's [Fuse](https://github.com/elmeragroup/fuse) design system, built on the frame of
Fuse's own docs site (its `apps/docs`). The landing is `src/app/(landing)`; each docs page is a
`page.mdx` route under `src/app/(docs)/docs` with an entry in [src/lib/pages.ts](src/lib/pages.ts),
which the side nav, the page's metadata and its Open Graph image read.

From the repository root:

```sh
pnpm turbo run dev --filter=@elmeragroup/docs     # next dev on :3033
pnpm turbo run test:run --filter=@elmeragroup/docs   # the Vitest unit tests
pnpm turbo run e2e --filter=@elmeragroup/docs     # build, then the Playwright specs against the standalone server
docker build --platform linux/amd64 -f apps/docs/Dockerfile --build-arg DOCS_ORIGIN=http://localhost:3000 -t intl-docs .
```

`DOCS_ORIGIN` is the origin absolute `og:image` URLs are built on
([src/lib/site-origin.ts](src/lib/site-origin.ts)); unset, a local build uses
`http://localhost:<PORT>`, or the port `pnpm start` serves on (3033) without `PORT`. The image refuses
to build without it. Each PR deploys a preview
([CONTRIBUTING.md](../../CONTRIBUTING.md#preview-the-docs-site)); the preview app's base hostname serves
[placeholder/](placeholder), which answers 404.
