FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

# Consume signed security updates from the pinned Alpine release branch.
RUN apk upgrade --no-cache

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev

COPY server.mjs hosted.mjs ./

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "const http = require('node:http'); const origin = new URL(process.env.THERUNDOWN_MCP_PUBLIC_ORIGIN); const request = http.request({ hostname: process.env.THERUNDOWN_MCP_BIND_HOST || '127.0.0.1', port: Number(process.env.THERUNDOWN_MCP_PORT || 3000), path: '/mcp', method: 'GET', headers: { Host: origin.host }, timeout: 3000 }, (response) => { response.resume(); response.on('end', () => process.exit(response.statusCode === 405 && response.headers.allow === 'POST' ? 0 : 1)); }); request.on('timeout', () => request.destroy(new Error('timeout'))); request.on('error', () => process.exit(1)); request.end();"]

CMD ["node", "hosted.mjs"]
