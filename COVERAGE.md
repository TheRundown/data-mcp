# Product API coverage (0.4.0 candidate)

Source coverage is not a claim of deployment or directory approval. The last live proof on 2026-10-03 found version 0.3.0 with six tools. A private ChatGPT connection is incomplete delivery.

The candidate registers 85 tools: six convenience tools, 75 canonical REST operations and four real WebSocket captures. This covers all 61 public-docs REST paths plus 14 additional customer operations, 47 compatibility aliases and 12 explicitly retired registrations. Private/admin, internal push/assistant and account mutation routes are excluded. Aff27 OFF; #11832 HOLD (experimental propposev excluded).

## REST operations

| Tool | Method | Canonical public route | Existing convenience coverage |
| --- | --- | --- | --- |
| `v2GetDelta` | GET | `/api/v2/delta` | No |
| `v2GetAllStats` | GET | `/api/v2/stats` | No |
| `v2GetStatsSample` | GET | `/api/v2/stats/sample` | No |
| `v2GetStatsByEvent` | GET | `/api/v2/events/{eventID}/stats` | No |
| `v2GetPlayerStatsByEvent` | GET | `/api/v2/events/{eventID}/players/stats` | No |
| `v2GetAllMarkets` | GET | `/api/v2/markets` | list_markets |
| `v2GetMarketsDelta` | GET | `/api/v2/markets/delta` | No |
| `v2GetMarketLinePriceHistory` | GET | `/api/v2/markets/history` | No |
| `v2GetMarketsParticipants` | GET | `/api/v2/markets/participants` | No |
| `v2GetTeamByID` | GET | `/api/v2/teams/{teamID}/` | No |
| `v2GetPlayersByTeam` | GET | `/api/v2/teams/{teamID}/players` | No |
| `v2GetTeamStats` | GET | `/api/v2/teams/{teamID}/stats` | No |
| `v2GetPlayerStatsByTeam` | GET | `/api/v2/teams/{teamID}/players/stats` | No |
| `v2GetPlayerByID` | GET | `/api/v2/players/{playerID}` | No |
| `v2GetSports` | GET | `/api/v2/sports` | list_sports |
| `v2GetDatesBySportIDs` | GET | `/api/v2/sports/dates` | No |
| `v2GetMarketsByDate` | GET | `/api/v2/sports/markets/{date}` | No |
| `v2GetEventsByDate` | GET | `/api/v2/sports/events/{date}` | No |
| `v2GetTeamsBySport` | GET | `/api/v2/sports/{sportID}/teams` | No |
| `v2GetEventsBySportAndDate` | GET | `/api/v2/sports/{sportID}/events/{date}` | list_events |
| `v2GetDatesBySportID` | GET | `/api/v2/sports/{sportID}/dates` | No |
| `v2GetDivisionsBySport` | GET | `/api/v2/sports/{sportID}/divisions` | No |
| `v2GetConferencesBySport` | GET | `/api/v2/sports/{sportID}/conferences` | No |
| `v2GetFuturesForSport` | GET | `/api/v2/sports/{sportID}/futures` | list_futures |
| `v2GetFuturesEventByID` | GET | `/api/v2/sports/{sportID}/futures/{eventID}` | No |
| `v2GetOpenersBySportAndDate` | GET | `/api/v2/sports/{sportID}/openers/{date}` | No |
| `v2GetClosingBySportAndDate` | GET | `/api/v2/sports/{sportID}/closing/{date}` | No |
| `v2GetMarketsBySportAndDate` | GET | `/api/v2/sports/{sportID}/markets/{date}` | list_markets |
| `v2GetBestOddsBySportAndDate` | GET | `/api/v2/sports/{sport_id}/odds/best-lines/{date}` | No |
| `v2GetSteamersBySportAndDate` | GET | `/api/v2/sports/{sport_id}/odds/steamers/{date}` | No |
| `v2GetOutliersBySportAndDate` | GET | `/api/v2/sports/{sport_id}/odds/outliers/{date}` | No |
| `v2GetAffiliates` | GET | `/api/v2/affiliates` | list_affiliates |
| `v2GetSportsbooks` | GET | `/api/v2/sportsbooks` | No |
| `v2GetSeasonTypes` | GET | `/api/v2/season_types` | No |
| `v2GetPublicTournament` | GET | `/api/v2/public/tournament/{tournament}` | No |
| `v2GetEventByID` | GET | `/api/v2/events/{eventID}` | get_main_lines |
| `v2GetEventOpeners` | GET | `/api/v2/events/{eventID}/openers` | No |
| `v2GetEventClosing` | GET | `/api/v2/events/{eventID}/closing` | No |
| `v2GetAvailableMarketsByEvent` | GET | `/api/v2/events/{eventID}/markets` | No |
| `v2GetMarketHistoryByEvent` | GET | `/api/v2/events/{eventID}/markets/history` | No |
| `v2GetOpeningPricesByEvent` | GET | `/api/v2/events/{eventID}/markets/opening` | No |
| `v2GetMarketLineHistoryByEvent` | GET | `/api/v2/events/{eventID}/markets/{marketID}/history` | No |
| `v2GetBestLineByEvent` | GET | `/api/v2/events/{eventID}/best-line` | No |
| `v2GetBestOddsByEvent` | GET | `/api/v2/events/{event_id}/odds/best-line` | No |
| `v2GetPlaysByEvent` | GET | `/api/v2/events/{eventID}/plays` | No |
| `v2GetHedgeOpportunities` | GET | `/api/v2/hedge` | No |
| `v2GetTopHedgeOpportunities` | GET | `/api/v2/hedge/top` | No |
| `v2GetHedgeOpportunityByID` | GET | `/api/v2/hedge/{id}` | No |
| `v2GetHedgeOpportunitiesByEvent` | GET | `/api/v2/hedge/event/{event_id}` | No |
| `v2GetBestOdds` | GET | `/api/v2/odds/best-line` | No |
| `v2GetSteamers` | GET | `/api/v2/odds/steamers` | No |
| `v2GetOutliers` | GET | `/api/v2/odds/outliers` | No |
| `v2GetParlayBook` | POST | `/api/v2/odds/parlay-book` | No |
| `v2GetBestParlayBook` | POST | `/api/v2/parlays/best-book` | No |
| `v1GetEventByID` | GET | `/api/v1/events/{eventId}` | No |
| `v1GetByLineID` | GET | `/api/v1/events/{eventId}/lines/{lineId}` | No |
| `v1GetDelta` | GET | `/api/v1/delta` | No |
| `v1GetDeltaV2` | GET | `/api/v1/deltaV2` | No |
| `v1GetBestLineMulti` | GET | `/api/v1/lines/best` | No |
| `v1GetMoneylines` | GET | `/api/v1/lines/{id}/moneyline` | No |
| `v1GetTotals` | GET | `/api/v1/lines/{id}/total` | No |
| `v1GetTeamTotals` | GET | `/api/v1/lines/{id}/team_total` | No |
| `v1GetSpreads` | GET | `/api/v1/lines/{id}/spread` | No |
| `v1GetSports` | GET | `/api/v1/sports` | No |
| `v1GetTeamsBySport` | GET | `/api/v1/sports/{sportID}/teams` | No |
| `v1GetDivisionsBySport` | GET | `/api/v1/sports/{sportID}/divisions` | No |
| `v1GetConferencesBySport` | GET | `/api/v1/sports/{sportID}/conferences` | No |
| `v1GetDatesBySport` | GET | `/api/v1/sports/{sportID}/dates` | No |
| `v1GetScheduleBySport` | GET | `/api/v1/sports/{sportID}/schedule` | No |
| `v1GetEventsBySportAndDate` | GET | `/api/v1/sports/{sportID}/events/{date}` | No |
| `v1GetOpenersBySportAndDate` | GET | `/api/v1/sports/{sportID}/openers/{date}` | No |
| `v1GetClosingBySportAndDate` | GET | `/api/v1/sports/{sportID}/closing/{date}` | No |
| `v1GetAffiliates` | GET | `/api/v1/affiliates` | No |
| `v1GetSportsbooks` | GET | `/api/v1/sportsbooks` | No |
| `v1GetSeasonTypes` | GET | `/api/v1/season_types` | No |

Each operation has its own strict path/query/body schema. No generic executor, arbitrary URL, method, header or credential input is exposed. The two POST operations only calculate from existing prices; they do not place a wager. Public source mappings are retained; credential/internal fields and retired affiliate data are excluded. Computed multi-leg results with a retired leg are omitted as a whole. Embedded delta JSON preserves its string type after applying the same data boundary.

The audited sources, generated catalog and counts are in product-operation-source.json, product-operations.json and product-operation-coverage.json. Verify reproducibility with `node scripts/generate-product-operations.mjs --check`. Source hashes pin the audited contracts; offline tests do not prove a live account entitlement.

## Compatibility aliases

| Alias | Canonical tool |
| --- | --- |
| `/api/v1/v2/delta` | `v2GetDelta` |
| `/api/v1/v2/stats` | `v2GetAllStats` |
| `/api/v1/v2/stats/sample` | `v2GetStatsSample` |
| `/api/v1/v2/events/{eventID}/stats` | `v2GetStatsByEvent` |
| `/api/v1/v2/events/{eventID}/players/stats` | `v2GetPlayerStatsByEvent` |
| `/api/v1/v2/markets` | `v2GetAllMarkets` |
| `/api/v1/v2/markets/delta` | `v2GetMarketsDelta` |
| `/api/v1/v2/markets/history` | `v2GetMarketLinePriceHistory` |
| `/api/v1/v2/markets/participants` | `v2GetMarketsParticipants` |
| `/api/v1/v2/teams/{teamID}/` | `v2GetTeamByID` |
| `/api/v1/v2/teams/{teamID}/players` | `v2GetPlayersByTeam` |
| `/api/v1/v2/teams/{teamID}/stats` | `v2GetTeamStats` |
| `/api/v1/v2/teams/{teamID}/players/stats` | `v2GetPlayerStatsByTeam` |
| `/api/v1/v2/players/{playerID}` | `v2GetPlayerByID` |
| `/api/v1/v2/sports` | `v2GetSports` |
| `/api/v1/v2/sports/dates` | `v2GetDatesBySportIDs` |
| `/api/v1/v2/sports/markets/{date}` | `v2GetMarketsByDate` |
| `/api/v1/v2/sports/events/{date}` | `v2GetEventsByDate` |
| `/api/v1/v2/sports/{sportID}/teams` | `v2GetTeamsBySport` |
| `/api/v1/v2/sports/{sportID}/events/{date}` | `v2GetEventsBySportAndDate` |
| `/api/v1/v2/sports/{sportID}/dates` | `v2GetDatesBySportID` |
| `/api/v1/v2/sports/{sportID}/divisions` | `v2GetDivisionsBySport` |
| `/api/v1/v2/sports/{sportID}/conferences` | `v2GetConferencesBySport` |
| `/api/v1/v2/sports/{sportID}/futures` | `v2GetFuturesForSport` |
| `/api/v1/v2/sports/{sportID}/futures/{eventID}` | `v2GetFuturesEventByID` |
| `/api/v1/v2/sports/{sportID}/openers/{date}` | `v2GetOpenersBySportAndDate` |
| `/api/v1/v2/sports/{sportID}/closing/{date}` | `v2GetClosingBySportAndDate` |
| `/api/v1/v2/sports/{sportID}/markets/{date}` | `v2GetMarketsBySportAndDate` |
| `/api/v1/v2/sports/{sport_id}/odds/best-lines/{date}` | `v2GetBestOddsBySportAndDate` |
| `/api/v1/v2/sports/{sport_id}/odds/steamers/{date}` | `v2GetSteamersBySportAndDate` |
| `/api/v1/v2/sports/{sport_id}/odds/outliers/{date}` | `v2GetOutliersBySportAndDate` |
| `/api/v1/v2/affiliates` | `v2GetAffiliates` |
| `/api/v1/v2/sportsbooks` | `v2GetSportsbooks` |
| `/api/v1/v2/events/{eventID}` | `v2GetEventByID` |
| `/api/v1/v2/events/{eventID}/openers` | `v2GetEventOpeners` |
| `/api/v1/v2/events/{eventID}/closing` | `v2GetEventClosing` |
| `/api/v1/v2/events/{eventID}/markets` | `v2GetAvailableMarketsByEvent` |
| `/api/v1/v2/events/{eventID}/markets/history` | `v2GetMarketHistoryByEvent` |
| `/api/v1/v2/events/{eventID}/markets/opening` | `v2GetOpeningPricesByEvent` |
| `/api/v1/v2/events/{eventID}/markets/{marketID}/history` | `v2GetMarketLineHistoryByEvent` |
| `/api/v1/v2/events/{eventID}/best-line` | `v2GetBestLineByEvent` |
| `/api/v1/v2/events/{event_id}/odds/best-line` | `v2GetBestOddsByEvent` |
| `/api/v1/v2/odds/best-line` | `v2GetBestOdds` |
| `/api/v1/v2/odds/steamers` | `v2GetSteamers` |
| `/api/v1/v2/odds/outliers` | `v2GetOutliers` |
| `/api/v1/v2/odds/parlay-book` | `v2GetParlayBook` |
| `/api/v1/v2/parlays/best-book` | `v2GetBestParlayBook` |

Aliases use the same customer handlers and are represented by the canonical operation tool. They are not hidden executable operations.

## Retired routes

| Method | Route | Status |
| --- | --- | --- |
| GET | `/api/v1/v2/hedge/{id}` | 410; not dispatched |
| GET | `/api/v1/v2/hedge/event/{eventID}` | 410; not dispatched |
| GET | `/api/v1/v2/hedge` | 410; not dispatched |
| GET | `/api/v1/v2/hedge/top` | 410; not dispatched |
| GET | `/api/v1/v2/hedge/top/mainline` | 410; not dispatched |
| GET | `/api/v1/v2/hedge/top/props` | 410; not dispatched |
| GET | `/api/v1/hedge` | 410; not dispatched |
| GET | `/api/v1/hedge/top` | 410; not dispatched |
| GET | `/api/v1/hedge/top/mainline` | 410; not dispatched |
| GET | `/api/v1/hedge/top/props` | 410; not dispatched |
| GET | `/api/v1/hedge/{id}` | 410; not dispatched |
| GET | `/api/v1/hedge/event/{eventID}` | 410; not dispatched |

## Real WebSocket captures

| Tool | Upstream route | Capability |
| --- | --- | --- |
| capture_v1_stream | /api/v1/ws | Legacy frames with explicit event/book scope |
| capture_market_stream | /api/v2/ws/markets | V2 price frames with event/sport, market and book scope |
| capture_live_stream | /api/v2/ws | Markets, scores, plays, stats, live game state and aliases, futures, hedge; supported subscribe/unsubscribe, usage, snapshot/resync, plays resume |
| capture_hedge_stream | /api/v2/ws/hedge | Dedicated hedge updates with independent HedgeAccess/pass gate |

ChatGPT uses HTTPS Streamable HTTP; the adapter opens a real authenticated TLS WebSocket upstream. This is not native ChatGPT WebSocket transport. One call has a 2-second handshake, at most 5 seconds of observation / 50 received messages / 256 KiB retained frames, and at most 100 ms graceful close before termination. An over-limit frame is discarded and the result marked incomplete. The account connection and subscription quotas still apply; multiplex calls allow at most three bounded subscriptions.

Every socket closes before its call finishes, including on cancellation or delegated credential expiry. No continuing/background feed, shared-user buffer, automatic reconnect or guaranteed coverage is provided. An empty window means only no captured data in that window. Plays alone supports durable resume using per-event cursors; a short window may be incomplete. Resync refreshes a supported snapshot and is not durable replay. Stats has no supported snapshot baseline or durable replay: obtain a REST stats baseline. Completion and gaps come from actual frames and acknowledgments.

## Auth, deployment and public listing

Legacy / and /mcp remain key-authenticated for data calls and permit anonymous initialization. /oauth/mcp uses each connected account with mcp:read; initialize requires a freshly validated OAuth token and challenges missing or invalid tokens with HTTP 401. Anonymous tools/list/brief/ping carries no Product data. OAuth tool errors include the documented mcp/www_authenticate challenge; no data call falls back to another account or a developer key.

Deploy the matching reviewed gateway change before claiming live full coverage. It independently allows only the catalog, freshly validates Citizen grants and closes each delegated socket by min(credential expiry, ten seconds). Revocation is rechecked at the next admission; the existing socket lifetime is bounded, not instant push revocation.

No public directory URL is verified. Publication requires actual publisher setup, review and Publish approval, followed by non-owner discovery/installation proof. Disclose hedge/parlay computations for OpenAI eligibility review under its gambling restrictions; read-only annotations do not prove eligibility. Preserve Aff27 OFF and #11832 HOLD.

### Restricted custom-plan streams

Existing Product stream handlers do not enforce every custom plan's period, live, player-prop and delayed-data boundary per frame. The new delegated priced-stream path therefore fails closed unless the account has all periods, live access, player props and zero delay. This applies to V1/market streams and priced multiplex channels; nonpriced multiplex channels retain their own gates. The dedicated hedge route preserves its existing pass/entitlement contract and enforces allowed book membership. Standard eligible Ultra plans keep their supported stream capabilities. Restricted custom plans can use appropriately scoped REST operations; this candidate does not claim full streaming compatibility for those custom plans.
