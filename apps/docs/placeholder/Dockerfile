# syntax=docker/dockerfile:1

# The preview app's `bootstrap` revision: the image that serves the app's base hostname, which carries the app's default
# traffic while each PR's preview is reached by its own label (.github/scripts/docs-container-app.sh). It answers 404 to
# every request, so no PR's code is ever on the default route. Build with this directory as the context:
#
#   docker build --platform linux/amd64 -f apps/docs/placeholder/Dockerfile -t intl-docs-placeholder apps/docs/placeholder

# Equal to .node-version and devEngines.runtime in package.json (tooling/lint/test/workspace.test.ts holds them).
ARG NODE_VERSION=26.13.0

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --chown=node:node server.ts ./
USER node
EXPOSE 3000
CMD ["node", "server.ts"]
