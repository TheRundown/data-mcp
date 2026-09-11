# Build for Glama's directory checks only. It runs the local stdio server so
# Glama's mcp-proxy can start it and answer MCP introspection. Production
# deploys build the hosted HTTP adapter from the root Dockerfile, and this
# file must not replace it. Build context is the repository root:
#   docker build -f glama/Dockerfile .
#
# The server exits at startup unless THERUNDOWN_API_KEY is non-empty. Any
# non-empty value is enough for initialize, tools/list and resources/list,
# which make no Product API call; tool calls need a real key.
FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

# Consume signed security updates from the pinned Alpine release branch.
RUN apk upgrade --no-cache

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev

COPY server.mjs ./

USER node

CMD ["node", "server.mjs"]
