# Official TheRundown Data MCP

> This is the official TheRundown source repository. `aigeon-ai/therundown` is unofficial.

A local, read-only Model Context Protocol server for TheRundown Product API. It fetches sports, affiliates, market definitions, events, futures, and open main lines using your own API key. It uses the official MCP SDK and Node.js 22+.

This directory is a runnable source example. There is no hosted data MCP endpoint or published npm package. The existing `https://docs.therundown.io/mcp` endpoint searches documentation only.

The separate [HTTP adapter candidate](HOSTED.md) is prepared for a future
operated service. It is excluded from the local ZIP and is never started by
`npm start`. No hosted data endpoint is available to install today.

The checked-out source is version **0.2.1**. It adds the `therundown://brief`
resource, shared first-conversation instructions, and structured error and empty
result explanations. The downloadable release below is still **0.2.0** until
the new versioned ZIP is published and verified.

Download the [versioned source bundle](https://therundown.io/downloads/therundown-data-mcp-0.2.0.zip), verify its [SHA-256 checksum](https://therundown.io/downloads/therundown-data-mcp-0.2.0.sha256), and extract it. The official ZIP SHA-256 is `d61934849b7ab017ecd9bdc65b1ad805453a81e73ab172485c785799449d3188`. The included [ZIP manifest](releases/0.2.0/MANIFEST.json) is the unmodified manifest for that ZIP; it verifies the ZIP contents, including its original README. This repository README adds repository setup material. From the extracted ZIP directory:

```sh
npm ci --ignore-scripts
npm test
```

To run the checked-out source instead, use Node.js 22+ from this repository:

```sh
npm ci --ignore-scripts
npm test
```

For Claude Desktop's manual local configuration, add this to `claude_desktop_config.json` where supported and restart the client. Use absolute Node 22+ and server paths; this source ZIP is not a `.mcpb` desktop extension:

```json
{
  "mcpServers": {
    "therundown-data": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/therundown-data-mcp-0.2.0/server.mjs"],
      "env": { "THERUNDOWN_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

For Cursor, use the global `~/.cursor/mcp.json` and make the key available in the environment that launches Cursor:

```json
{
  "mcpServers": {
    "therundown-data": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/therundown-data-mcp-0.2.0/server.mjs"],
      "env": { "THERUNDOWN_API_KEY": "${env:THERUNDOWN_API_KEY}" }
    }
  }
}
```

Client references: [local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers), [Cursor](https://cursor.com/docs/mcp).

Replace the path and key locally. Use your client's secret storage or inherited environment when available. Do not commit a filled-in client config. The server reads `THERUNDOWN_API_KEY` from its process environment and sends it only as `X-TheRundown-Key`; keys are never accepted as tool arguments. `stdout` contains only MCP protocol messages. A missing key exits with a generic message on `stderr`.

The six tools are:

| Tool | What it does | When not to use it for discovery |
| --- | --- | --- |
| `list_sports` | Lists current public sport IDs and names. | Do not infer that a sport has events or price coverage from its catalog row. |
| `list_affiliates` | Lists current public affiliate IDs and names. | Do not use it as proof that a book offers a requested sport or market; retired 27 is excluded. |
| `list_markets` | Lists market definitions, or date-scoped markets for a sport. | Do not treat definitions as open prices; date-scoped discovery rejects `live`. |
| `list_events` | Finds dated event summaries and available market IDs for one sport. | Do not select an event from memory or a similarly named result; resolve the exact participant, date, and timezone first. |
| `get_main_lines` | Fetches open per-affiliate main lines for one exact event ID. | Do not call it before `list_events`, or use it to search for an event; it requires the exact returned ID. |
| `list_futures` | Lists scoped futures competition boards with public schedule, settlement, and open main-line fields. | Do not use it for ordinary dated event discovery or assume a catalog/settlement status alone proves the board is fully settled. |

`list_markets` keeps catalog discovery and can also discover markets available for one `sport_id` and `date`; date-based discovery rejects `live` because that endpoint does not classify live markets. Event queries always use `main_line=true`, `hide_closed=true`, and `include=all_periods`. `list_futures` is an Ultra+ competition endpoint with scoped defaults `[1141]` and `[19,23]`, opaque cursor pagination, public schedule/settlement fields, and open per-affiliate main lines without line IDs. Defaults for dated event tools remain markets `[1,2,3]` and affiliates `[19,23]`. Pass live markets `[41,42,43]` explicitly. Retired affiliate 27 is rejected and excluded from discovery.

## First conversation

```text
Use TheRundown to list current sports and affiliates. Find MLB (sport 3).
For today's UTC date, list events with market_ids [1,2,3]
and affiliate_ids [19,23]. Select an event ID from that response and
call get_main_lines with the same filters.
Show the source URL, each book's line value and price updated_at,
and the returned usage headers. Explain empty results without inventing odds.
```

`npm test` runs offline. To check actual Product API data, privately set `THERUNDOWN_API_KEY` and run `npm run smoke`. The default checks pre-match `[1,2,3]` for MLB and affiliates `[19,23]`. Free includes delayed pre-match odds and excludes live odds, props/alternates, and history; a source catalog row does not grant access to it.

With an eligible key, `THERUNDOWN_SMOKE_LIVE=1 npm run smoke` also requests live `[41,42,43]`. `THERUNDOWN_SMOKE_DATE=YYYY-MM-DD` and `THERUNDOWN_SMOKE_SPORT_ID` select the dated scope. For a bounded Ultra+ competition check, set `THERUNDOWN_SMOKE_FUTURES=1` and a sport such as `40` (PGA) or `41` (Formula 1); it requests only market `1141` and affiliates `19,23`. The check has a 60-second deadline, verifies all six tool names, and reports its UTC check time, scope, selected event ID, source URLs, usage, and counts. Require `status: "ok"`, six tools, and positive event/main-line counts. Empty data is inconclusive and exits 2. These requests are opt-in and metered.

Usage, API plan delays, and entitlements apply to every request. Catalog, date-market, event, and main-line pages paginate locally, so each page refetches a snapshot and is separately metered. `list_futures` uses the API's upstream opaque cursor and page limit; each cursor page is still a metered request and is only a partial competition listing when `has_more` is true. Results expose safe source URLs, retrieval timestamps, API usage headers, and per-price `updated_at`; a retrieval timestamp is not evidence that a price is fresh.

## Agent brief and errors in 0.2.1

Read `therundown://brief` through MCP resources for the current Build with AI
rules and first conversation. Initialization returns the same instructions;
neither operation calls the Product API.

HTTP failures return `status`, `plan`, `missing_entitlement`, `required_plan`,
`retry_after` (seconds), `remaining_points`, `monthly_remaining_points`, and
`limit_reason`, alongside the safe source URL, retrieval time, and usage headers.
Fields stay `null` when the API does not supply a recognized value. The server
does not guess the current plan from a denied feature. Raw upstream error bodies
are never returned, and errors do not trigger automatic retries.

An empty successful result retains its normal `data` shape and adds `empty`
with a code, explanation, and request scope. Dated results report the sport,
date, and date-boundary offset (UTC at zero); a page beyond existing results is
identified separately from an empty slate. Empty odds do not establish absent
coverage.

See [the setup guide](https://docs.therundown.io/data-mcp), [DESIGN.md](DESIGN.md), [authentication](https://docs.therundown.io/authentication), and [billing](https://docs.therundown.io/rate-limits). Read the [OpenAPI specification](https://docs.therundown.io/openapi.yaml), [sports catalog](https://therundown.io/api/v2/sports), [markets catalog](https://therundown.io/api/v2/markets), [affiliates catalog](https://therundown.io/api/v2/affiliates), [TheRundown llms.txt](https://therundown.io/llms.txt), and [documentation llms.txt](https://docs.therundown.io/llms.txt) for current public contracts and IDs.
