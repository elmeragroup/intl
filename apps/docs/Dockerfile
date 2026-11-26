# syntax=docker/dockerfile:1

# The docs site image. Build from the repository root, with the public origin the image will serve:
#
#   docker build --platform linux/amd64 -f apps/docs/Dockerfile --build-arg DOCS_ORIGIN=https://docs.example.com -t intl-docs .
#
# Pages and Open Graph images prerender during `next build`, so the runtime stage carries only Next's standalone server
# and its static assets, and serving fetches nothing from the network.

# Equal to .node-version and devEngines.runtime in package.json (tooling/lint/test/workspace.test.ts holds the three).
ARG NODE_VERSION=26.13.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo

FROM base AS build
# Install the pnpm release `packageManager` names with npm, since Node 26 ships without Corepack.
COPY package.json ./
RUN npm install --global "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"
# Fetch the store from the lockfile alone, so this layer survives source-only changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
# The base image's Node is the pin, so the install skips linking pnpm's own copy of it.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --offline --no-runtime
# The public origin the image serves, which absolute og:image URLs need (apps/docs/src/lib/site-origin.ts). Pages
# prerender here, so the build bakes it in; the preview workflow reads it from the Container Apps environment first.
# Without it the site would fall back to http://localhost:3000, which no visitor can reach, so an empty value fails the
# build. Declared after the install layers so a new origin keeps their cache.
ARG DOCS_ORIGIN
RUN test -n "$DOCS_ORIGIN" || { echo "Set the DOCS_ORIGIN build argument to the origin the image serves." >&2; exit 1; }
ENV DOCS_ORIGIN=${DOCS_ORIGIN}
# The task apps/docs/turbo.json declares DOCS_ORIGIN on, so turbo's strict env mode passes it to `next build`.
RUN pnpm exec turbo run build --filter=@elmeragroup/docs

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# Every page bakes the build's origin into its HTML; the server keeps the same value, so a request-time read could only
# agree with it.
ARG DOCS_ORIGIN
ENV DOCS_ORIGIN=${DOCS_ORIGIN} \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# The standalone tree mirrors the workspace (outputFileTracingRoot), so the server sits at apps/docs/server.js. The
# `build` script has copied the static assets in, which Next leaves for the host; the app has no public/ directory.
COPY --from=build --chown=node:node /repo/apps/docs/.next/standalone ./
USER node
EXPOSE 3000
WORKDIR /app/apps/docs
CMD ["node", "server.js"]
