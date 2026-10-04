# Hosted MCP adapter

`hosted.mjs` is the Streamable HTTP adapter for the same six read-only tools
exported by `server.mjs`. It is deployed and publicly reachable at
`https://mcp.therundown.io/mcp` (Streamable HTTP, `POST`). The local stdio MCP
remains available as a separate install for operators who prefer not to depend
on a hosted endpoint. It still makes HTTPS Product API calls with the operator's
key, so it is not an offline or air-gapped option.

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
credential store. Responses are `Cache-Control: no-store`. On the legacy `/`
and `/mcp` routes, initialization, the initialized notification, tool and resource
listing, and reads of the exact `therundown://brief` resource may omit credentials
and never call the Product API. For every legacy Product tool call, send exactly
one Product API key:

```http
X-TheRundown-Key: YOUR_PRODUCT_API_KEY
```

or

```http
Authorization: Bearer YOUR_PRODUCT_API_KEY
```

Never send a key in a URL. The adapter rejects missing credentials on protected
methods and malformed, duplicate, or ambiguous credential headers on every
method, including requests that send both forms. Anonymous requests for any
method or resource outside the narrow metadata allowlist return `401`.

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
Discovering tools does not validate a key or establish any entitlement. All
anonymous discovery requests share one per-process concurrency identity and
remain subject to the process and request limits above.

## OAuth account connection

This section describes the 0.3.0 candidate. The OAuth route requires the matching
authorization service and Product gateway changes, operator secret configuration,
and live acceptance before it can be advertised as available.

The separate `POST /oauth/mcp` route supports per-user account connection for
ChatGPT and other OAuth clients. Its protected resource is exactly
`https://mcp.therundown.io/oauth/mcp`, authorization server is
`https://auth.therundown.io`, and required scope is `mcp:read`. Clients use a
preregistered OAuth client and the authorization server's metadata; this adapter
does not implement dynamic client registration. Its six tool descriptors
advertise `oauth2` with scope `mcp:read` at the top level and in `_meta`.

An operator enables this route with a secret injected into
`THERUNDOWN_MCP_EXCHANGE_SECRET`. The protected resource metadata is available
at `GET /.well-known/oauth-protected-resource/oauth/mcp` when enabled. Missing
or invalid OAuth authentication returns `401` with a `WWW-Authenticate`
challenge pointing to that metadata. Without the exchange secret, OAuth data
requests return `503` and protected resource metadata returns `404`.
The secret must never be placed in source, client configuration, or a URL.

OAuth data requests send exactly one header:

```http
Authorization: Bearer YOUR_OAUTH_ACCESS_TOKEN
```

This route rejects Product key headers, credential aliases, duplicate headers,
and requests that combine credential forms. It never falls back to raw Product
key authentication. The existing `/` and `/mcp` routes continue to use Product
keys for data calls and allow anonymous initialization. On the enabled
OAuth route, initialization requires a valid bearer token and a fresh exchange;
missing or invalid tokens receive HTTP 401 with the protected-resource metadata
URL and `mcp:read` scope in `WWW-Authenticate`. Initialization does not call
Product. Anonymous tool and resource listing, ping, and the exact brief resource
remain available without contacting either upstream service.

For every protected OAuth request, the adapter makes one server-side request
to the fixed HTTPS endpoint `https://auth.therundown.io/mcp/exchange/`, carrying
the bearer token, service secret, and exact resource. Citizen validates the live
grant and selected account and returns a signed `mcp1.` Product credential,
account identity, expiry, scope, and resource. The adapter requires the exact
five-field response, a 32-character UUID hex account identity, and an unexpired
credential with at most 60 seconds remaining (five seconds allowed for clock
skew). The credential is `mcp1.` followed by the canonical base64url encoding
of the complete signed blob, with a maximum total length of 4096 characters.
Exchange responses are limited to 16 KiB. Only the delegated credential
is sent to Product, in `X-TheRundown-Key`; OAuth tokens and the exchange service
secret are never sent to Product.

There is no token or credential cache, queue, automatic retry, or redirect
following. The request body, exchange, and Product operation share the same
total request deadline and cancellation handling. Admission limits each bearer
token to one active request before exchange. After successful exchange, an
account guard prevents multiple tokens for the same account from performing
concurrent Product work. Process capacity applies across both authentication
routes; maps contain only digests and are cleared after upstream work settles.

Exchange `401`, `403`, and `429` failures retain their HTTP status with sanitized
messages; a bounded numeric `Retry-After` from an exchange `429` is preserved.
Unavailable, redirected, malformed, incorrectly scoped, expired, or
oversized responses return `503`. Exchange errors never expose response bodies,
tokens, delegated credentials, or the service secret. Product entitlements,
usage, and errors still come from the existing six tools and Product API.

The local ZIP exporter excludes the HTTP listener and OAuth exchange helper;
starting `server.mjs` continues to use stdio only. Network access is still
needed for Product API reads.

## Container packaging

The repository includes a generic runtime `Dockerfile` for the adapter. It
installs only production dependencies and copies only the adapter and local
server source. The separate `glama/Dockerfile` runs the local stdio server for
Glama's directory checks and is not used for hosted rollouts:

```sh
docker build -t therundown-data-mcp-hosted .
docker run --rm \
  -e THERUNDOWN_MCP_PUBLIC_ORIGIN=https://mcp.example.com \
  therundown-data-mcp-hosted
```

The container keeps the adapter on loopback. A same-task HTTPS reverse proxy is
an operator deployment concern and is not configured by this repository. The
container health check makes an unauthenticated loopback `GET /mcp`, using the
configured public origin only to set the required `Host` header; it expects
`405` and `Allow: POST` and does not read the Product API.

This Dockerfile packages the adapter for operator rollouts; it is not a
statement that the currently hosted `https://mcp.therundown.io/mcp` endpoint
runs this exact container. The request and concurrency limits described above
apply to one container process; a multi-task deployment needs its own shared
or edge enforcement.
