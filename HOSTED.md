# Future hosted MCP adapter

`hosted.mjs` is an implementation candidate for a loopback-only Streamable HTTP adapter for the
same six read-only tools exported by `server.mjs`. It is not a claim that
`https://mcp.therundown.io` is deployed, routable, or available today. The
local stdio MCP remains the published service until an operator provisions and
verifies a separate rollout.

An operator must set a concrete public origin and run it behind an HTTPS
terminating proxy that preserves the matching `Host` header. The adapter accepts
`POST /` and `POST /mcp`; it uses JSON responses and returns `405` for GET, so
it does not keep standalone SSE streams. A browser may send a CORS `OPTIONS`
preflight only from the configured origin, only for `POST`, and only for
`Authorization`, `Content-Type`, `Mcp-Protocol-Version`, and
`X-TheRundown-Key`. Its listener defaults to loopback.

```sh
THERUNDOWN_MCP_PUBLIC_ORIGIN=https://mcp.example.com \
THERUNDOWN_MCP_PORT=3000 \
node hosted.mjs
```

The public origin must be a bare HTTPS origin (HTTP is accepted only for
loopback test origins). There is no wildcard CORS policy, no query credentials,
no proxy configuration, no alternate API host, and no stored session or customer
credential store. Responses are `Cache-Control: no-store`. Send exactly one Product
API key on every request:

```http
X-TheRundown-Key: YOUR_PRODUCT_API_KEY
```

or

```http
Authorization: Bearer YOUR_PRODUCT_API_KEY
```

Never send a key in a URL. The adapter rejects missing, malformed, duplicate,
or ambiguous credential headers, including requests that send both forms.

Each key has one active HTTP request at a time. The process has a hard cap of
16 active requests by default, configurable with `THERUNDOWN_MCP_MAX_CONCURRENT`
up to 64. A full slot returns `429` with `Retry-After: 1`; requests are never
queued or retried. Request JSON is limited to 64 KiB, upstream work is aborted
on disconnect or timeout, including an already-open upstream response body, and
active slots remain held until that work settles. The active map contains only
SHA-256 digests and is removed at request cleanup.

The request deadline defaults to 20 seconds and cannot exceed 60 seconds.
Socket capacity is bounded at eight times the configured request cap. These
caps apply to one process; a multi-process rollout needs a shared or edge limit
before it can claim the same limits across the service.

HTTP adapter errors expose JSON-RPC `error.data` with status, nullable plan and
entitlement details, retry delay, and remaining points. Capacity errors identify
`limit_reason: "mcp_capacity"`; they do not imply the Product API quota is used
up. Credentials and bodies are not logged.

Product API authentication, entitlements, data-point usage, rate limiting, and
tool results remain the authority of `createDataServer` and the Product API.
Discovering tools does not validate a key or establish any entitlement.

This adapter uses explicitly configured Product API keys, not OAuth access
tokens. It does not advertise OAuth discovery or automatic account linking.
The local ZIP exporter excludes this file and the HTTP listener; starting
`server.mjs` continues to use stdio only. Network access is still needed for
Product API reads.
