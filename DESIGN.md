# Data MCP design and release criteria

Status: local source 0.2.1, September 9, 2026. Owner: TheRundown.

## Scope

Make an agent's first authenticated sports-data query explicit and reproducible. Six read-only tools cover reference discovery, date-based market discovery, event selection, futures pages, and per-affiliate main-line snapshots. They wrap existing Product V2 endpoints and inherit the calling key's entitlements and billing.

```text
MCP client → local stdio process → HTTPS Product API
                ↑
       process environment key
       X-TheRundown-Key upstream
```

The official MCP SDK owns protocol negotiation, framing, cancellation, and tool schema validation. This scaffold registers tools with strict Zod input schemas. It has no HTTP listener, OAuth provider, remote session store, or published package identity. The documentation MCP remains a separate service.

## Contract

| Tool              | Product API request                                                      | Projection                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `list_sports`     | `GET /api/v2/sports`                                                     | ID and name.                                                                                                               |
| `list_affiliates` | `GET /api/v2/affiliates`                                                 | ID and name; retired 27 removed.                                                                                           |
| `list_markets`    | `GET /api/v2/markets`, or `GET /api/v2/sports/{sport_id}/markets/{date}` | Catalog definitions, or date-scoped available markets with `hide_closed_markets=1`.                                        |
| `list_events`     | `GET /api/v2/sports/{sport_id}/events/{date}`                            | Summaries from the `events` envelope, with canonical IDs and available market IDs.                                         |
| `get_main_lines`  | `GET /api/v2/events/{event_id}`                                          | Select the exact event from its `events` envelope, then flatten per-affiliate main-line prices.                            |
| `list_futures`    | `GET /api/v2/sports/{sport_id}/futures`                                  | Scoped competition events, public schedule/settlement fields, open per-affiliate main lines, and upstream cursor metadata. |

Dated event tools require 1–12 canonical market IDs and 1–10 affiliate IDs, defaulting to `[1,2,3]` and `[19,23]`, and force `main_line=true&hide_closed=true&include=all_periods`. Date-based `list_markets` requires `sport_id`, uses only `hide_closed_markets=1` and a bounded offset, and rejects `live`. `list_futures` defaults to market `[1141]` and affiliates `[19,23]`; it accepts only bounded market/book filters, a 1–200 page limit, `include_settled`, and the returned opaque forward cursor. No tool accepts a key, URL, host, path, or arbitrary query parameter. Date inputs must be real calendar dates; event IDs cannot contain path delimiters. Affiliate 27 remains off even if a stale upstream catalog returns it.

Dated price projection preserves participant identity/type, market/period, line ID/value, affiliate ID, price, main-line state, and upstream update time. Futures omit line IDs and return only public event identity, schedule, settlement, market IDs, and open per-affiliate main lines. Main lines belong to each affiliate; different books can have different main values. Missing line values remain null (for example, moneyline). The scaffold does not calculate best price, implied probability, edge, or consensus, so it never mixes exchange/prediction-market quotes into sportsbook ranking.

The result envelope is `{source_url, retrieved_at, usage, data}` in structured content and JSON text. Source URLs are reproducible and credential-free. Catalog, date-market, event, and main-line pagination provides `items`, `total`, `page`, `limit`, and `next_page`; each local page is a fresh upstream snapshot, not a stable cursor or billing optimization. Futures preserves upstream `count`, `total`, `has_more`, and `next_cursor`; a cursor page is still metered and may be partial. Catalog presence and empty market responses are not evidence of full or absent coverage.

`therundown://brief` exposes the Build with AI rules and first conversation as
Markdown. Initialization includes the same instructions. Both are local
discovery operations with no Product API call. Empty successes add an `empty`
explanation and scope outside `data`, preserving pagination shape. Errors expose
recognized plan/entitlement/usage/retry fields with unknown values set to null;
error bodies are bounded to 64 KiB and never echoed.

## Request and credential boundaries

- The executable uses one fixed HTTPS Product origin and GET-only paths. Redirects fail rather than forwarding a key to another origin.
- The key comes from the process environment and is sent only in `X-TheRundown-Key`. The server does not read a repository `.env` automatically, log request headers, or return raw error bodies. Configured key text is redacted from tool output.
- One request may be in flight. Extra concurrent calls return `busy`; calls are not queued and there are no automatic retries. Clients control request cadence and should respect `429`/`Retry-After` and the calling plan's quota.
- A 15-second deadline and MCP cancellation abort the fetch/body read. Upstream bodies are capped at 4 MiB before JSON parsing. Large requests fail explicitly instead of returning silent partial odds.
- Only allowlisted usage/entitlement headers are returned. `401`, `403`, `404`, and `429` get useful, sanitized messages. Transport and unexpected errors get a generic error; stdout is reserved for MCP.

An API key can incur data-point usage even for read-only tools. Local page limits trim tool output only; the futures limit is forwarded upstream, but each cursor page remains metered. The client should present tool calls and costs to its user according to its normal permissions model.

## Verification

Offline tests exercise MCP initialization/discovery, strict schemas, all 36 catalog identities, dated market discovery, PGA/F1/team-sport futures scope, closed/sentinel/retired quote filtering, cursor metadata, usage headers, errors, cancellation/timeouts, and bounded response handling. The stdio smoke client checks the actual executable; network calls happen only when explicitly running `npm run smoke` with a key.

The smoke client defaults to pre-match markets 1/2/3 for sport 3 and affiliates 19/23. An eligible key can opt into the combined pre-match/live check with `THERUNDOWN_SMOKE_LIVE=1`, adding 41/42/43. `THERUNDOWN_SMOKE_SPORT_ID` and `THERUNDOWN_SMOKE_DATE` scope a dated check. An Ultra+ key can opt into one bounded futures page with `THERUNDOWN_SMOKE_FUTURES=1`; it requests market 1141 and affiliates 19/23 for the selected sport. It validates the exact six-tool contract before data requests. The dated mode selects an event whose summary reports a requested market ID and spaces its two Product API calls by one second for Free-plan compatibility; futures mode makes one bounded `list_futures` call. Both report the UTC check time, requested scope, selected event ID where available, source URLs, counts, and usage. Require positive event and visible-price counts. Record this output without keys or full customer payloads. An empty date is inconclusive. A successful narrow check says nothing about other sports, sources, freshness guarantees, or WebSocket delivery.

## Publication sequence

1. Keep the tested source commit immutable. From that exact commit, create a separate website artifact change using `bundle.py`; it must produce the versioned ZIP, checksum, and manifest with matching source hashes.
2. Deploy the website artifact and verify the public ZIP, checksum, manifest, and finite smoke proof before merging the guide that links to it. Keep the package private until that download is available.
3. Choose distribution: a versioned package or MCPB for local clients, or an operated Streamable HTTP service. Provide reproducible installation, a license decision, ownership metadata, and a support/update policy.
4. A hosted service needs MCP authentication, per-user upstream-key isolation, request/rate budgets, secret redaction, Origin validation, session isolation and bounded shutdown. Implement the MCP authorization specification; do not treat a caller's MCP access token as a Product API key or blindly pass it to the upstream API. No hosted URL is advertised by this scaffold.
5. Publish a real artifact and valid `server.json` using a verified namespace, then submit registry metadata. Do not create metadata pointing to a nonexistent npm package or remote URL. Confirm directory-specific prerequisites before submitting.
6. Verify the registry entry, install from the public artifact, and record a working listing URL before claiming availability in public materials.

References: [official SDK server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md), [MCP tool specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [registry quickstart](https://modelcontextprotocol.io/registry/quickstart), [TheRundown OpenAPI](https://docs.therundown.io/openapi.yaml).
