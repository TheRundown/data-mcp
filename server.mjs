import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = 'https://therundown.io/api/v2';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const RETIRED_AFFILIATES = new Set([27]);
const USAGE_HEADERS = [
  'x-datapoints', 'x-datapoints-used', 'x-datapoints-remaining',
  'x-datapoints-limit', 'x-datapoints-period', 'x-datapoints-reset',
  'x-datapoints-monthly-remaining', 'x-data-delay-seconds', 'x-websocket-access',
];

class ApiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const id = z.number().int().positive().max(2147483647);
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, 'Use a real calendar date in YYYY-MM-DD format');
const opaqueCursor = z.string().min(1).max(4096).refine((value) => !/[\r\n]/.test(value), 'Use the opaque cursor returned by list_futures.');
const paging = {
  page: z.number().int().min(1).max(1000).default(1),
  limit: z.number().int().min(1).max(200).default(50),
};
const filters = {
  market_ids: z.array(id).min(1).max(12).default([1, 2, 3])
    .describe('Canonical market IDs. Prematch 1/2/3; live 41/42/43. Discover with list_markets.'),
  affiliate_ids: z.array(id.refine((value) => !RETIRED_AFFILIATES.has(value), 'Retired affiliate'))
    .min(1).max(10).default([19, 23])
    .describe('Canonical affiliate IDs; defaults to 19 and 23. Discover current IDs with list_affiliates.'),
};
const futureFilters = {
  market_ids: z.array(id).min(1).max(12).default([1141])
    .describe('Canonical futures market IDs; defaults to 1141. Discover with list_markets.'),
  affiliate_ids: filters.affiliate_ids,
};

const isPublicScalar = (value) => value === null || typeof value === 'string'
  || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
const isCanonicalId = (value) => Number.isInteger(value) && value > 0 && value <= 2147483647;
const pick = (value, keys) => Object.fromEntries(
  keys.filter((key) => isPublicScalar(value?.[key])).map((key) => [key, value[key]]),
);
const publicIdArray = (value) => Array.isArray(value) ? value.filter(isCanonicalId) : undefined;

function pageOf(items, { page = 1, limit = 50 }) {
  const start = (page - 1) * limit;
  return {
    items: items.slice(start, start + limit),
    total: items.length,
    page,
    limit,
    next_page: start + limit < items.length ? page + 1 : null,
  };
}

function arrayAt(body, key) {
  const rows = key === null ? body : body?.[key];
  if (!Array.isArray(rows)) {
    throw new ApiError('invalid_response', 'The API returned an unexpected response shape.');
  }
  return rows;
}

function dateMarketRows(body, sportId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError('invalid_response', 'The API returned an unexpected response shape.');
  }
  const entries = Object.entries(body);
  if (entries.length === 0) return [];
  if (entries.length !== 1 || entries[0][0] !== String(sportId) || !Array.isArray(entries[0][1])) {
    throw new ApiError('invalid_response', 'The API returned an unexpected response shape.');
  }
  if (entries[0][1].some((market) => !market || typeof market !== 'object'
    || Array.isArray(market) || !isCanonicalId(market.id))) {
    throw new ApiError('invalid_response', 'The API returned an unexpected response shape.');
  }
  return entries[0][1];
}

function eventSummary(event) {
  const teams = Array.isArray(event.teams_normalized)
    ? event.teams_normalized
    : Array.isArray(event.teams) ? event.teams : [];
  const score = event.score === null
    ? null
    : event.score && typeof event.score === 'object' && !Array.isArray(event.score)
    ? pick(event.score, [
      'event_status', 'score_away', 'score_home', 'game_clock', 'display_clock',
      'game_period', 'event_status_detail', 'updated_at',
    ])
    : undefined;
  return {
    ...pick(event, ['event_id', 'sport_id', 'event_date']),
    ...(score === undefined ? {} : { score }),
    teams: teams.map((team) =>
      pick(team, ['team_id', 'name', 'mascot', 'is_home', 'is_away'])),
    market_ids: publicIdArray(Array.isArray(event.markets)
      ? event.markets.map((market) => market?.market_id) : []) ?? [],
  };
}

function mainLineRows(event, args) {
  const rows = [];
  for (const market of Array.isArray(event.markets) ? event.markets : []) {
    if (!market || typeof market !== 'object' || Array.isArray(market)) continue;
    if (!args.market_ids.includes(market.market_id)) continue;
    for (const participant of Array.isArray(market.participants) ? market.participants : []) {
      if (!participant || typeof participant !== 'object' || Array.isArray(participant)) continue;
      for (const line of Array.isArray(participant.lines) ? participant.lines : []) {
        if (!line || typeof line !== 'object' || Array.isArray(line)) continue;
        for (const [affiliate, price] of Object.entries(line.prices ?? {})) {
          const affiliateId = Number(affiliate);
          // Preserve the API's per-affiliate main-line decision; never choose
          // one shared line or infer openness from a schedule status.
          if (!price || typeof price !== 'object' || Array.isArray(price)
            || !args.affiliate_ids.includes(affiliateId) || RETIRED_AFFILIATES.has(affiliateId)
            || (price.affiliate_id !== undefined && (!isCanonicalId(price.affiliate_id) || price.affiliate_id !== affiliateId))
            || price.is_main_line !== true || (price.closed_at != null && price.closed_at !== '') || price.price === 0.0001 || price.price === 0
            || !Number.isFinite(price.price)) continue;
          rows.push({
            ...pick(market, ['market_id']),
            ...(isPublicScalar(market.name) ? { market_name: market.name } : {}),
            ...pick(market, ['period_id']),
            participant: pick(participant, ['id', 'type', 'name']),
            ...(isPublicScalar(line.id) ? { line_id: line.id } : {}),
            line_value: isPublicScalar(line.value) ? line.value : null,
            affiliate_id: affiliateId,
            ...pick(price, ['price', 'is_main_line', 'updated_at']),
          });
        }
      }
    }
  }
  return rows;
}

async function readBoundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError('invalid_response', 'The API returned no response body.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ApiError('response_too_large', 'Response exceeds 4 MiB. Request fewer markets or affiliates.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError('invalid_response', 'The API did not return valid JSON.');
  }
}

// Dependency injection is for offline tests. The executable always uses the
// fixed HTTPS origin and reads its key only from the process environment.
export function createDataServer({ apiKey = process.env.THERUNDOWN_API_KEY, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!apiKey?.trim() || /[\r\n]/.test(apiKey)) {
    throw new Error('Set THERUNDOWN_API_KEY in the MCP process environment.');
  }
  apiKey = apiKey.trim();
  const server = new McpServer({ name: 'therundown-data', version: '0.2.0' }, {
    instructions: 'Read-only TheRundown data. Discover IDs before requesting odds. Calls consume the API key’s data-point allowance. Quote source_url and price updated_at; retrieved_at is fetch time, not price freshness. Empty results do not prove unavailable coverage. This local scaffold does not place bets or stream WebSocket updates.',
  });
  let active = false;
  const encodedKey = encodeURIComponent(apiKey);
  const percentEncodingPattern = (value) => new RegExp(value.split(/(%[0-9A-F]{2})/).map((part) => {
    if (/^%[0-9A-F]{2}$/.test(part)) {
      return `%[${part[1].toLowerCase()}${part[1].toUpperCase()}][${part[2].toLowerCase()}${part[2].toUpperCase()}]`;
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join(''), 'g');
  const encodedKeyPatterns = [
    percentEncodingPattern(encodedKey),
    percentEncodingPattern(encodedKey.replaceAll('%20', '+')),
  ];
  const redactText = (value) => encodedKeyPatterns.reduce(
    (redacted, pattern) => redacted.replaceAll(pattern, '[REDACTED]'),
    value.replaceAll(apiKey, '[REDACTED]'),
  );
  const redact = (value) => {
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        redactText(key), redact(item),
      ]));
    }
    return value;
  };
  const serialize = (value) => JSON.stringify(redact(value));

  async function request(path, query, signal) {
    if (active) throw new ApiError('busy', 'One API request is already active. Wait for it to finish.');
    active = true;
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { 'X-TheRundown-Key': apiKey, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      });
      const usage = Object.fromEntries(USAGE_HEADERS
        .filter((header) => response.headers.has(header))
        .map((header) => [header, response.headers.get(header)]));
      if (!response.ok) {
        await response.body?.cancel();
        const messages = {
          401: 'The API key was rejected. Check the MCP process environment.',
          403: 'The API denied this request. Check key entitlements and access.',
          404: 'No matching API resource was found. Rediscover the event ID.',
          429: 'API usage or rate limit reached. Respect retry_after; do not automatically retry.',
        };
        const retryAfter = response.headers.get('retry-after');
        throw new ApiError('upstream_error', messages[response.status] ?? 'The API request failed.', {
          status: response.status,
          usage,
          ...(retryAfter && /^\d{1,10}$/.test(retryAfter) ? { retry_after: Number(retryAfter) } : {}),
        });
      }
      return {
        source_url: url.href,
        retrieved_at: new Date().toISOString(),
        usage,
        data: await readBoundedJson(response),
      };
    } finally {
      active = false;
    }
  }

  function tool(name, description, inputSchema, handler) {
    server.registerTool(name, {
      description,
      inputSchema: z.object(inputSchema).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args, extra) => {
      try {
        const output = await handler(args, extra.signal);
        // Even unexpected upstream echo content cannot expose the configured key.
        const text = serialize(output);
        return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) };
      } catch (error) {
        const output = error instanceof ApiError
          ? { error: error.code, message: error.message, ...error.details }
          : { error: 'request_failed', message: 'The API request timed out, was cancelled, or failed. No automatic retry was made.' };
        const text = serialize(output);
        return { isError: true, content: [{ type: 'text', text }] };
      }
    });
  }

  tool('list_sports', 'List canonical sports from TheRundown. A registered sport does not guarantee current events or coverage.', {}, async (_, signal) => {
    const result = await request('/sports', {}, signal);
    result.data = { sports: arrayAt(result.data, 'sports').map((sport) => pick(sport, ['sport_id', 'sport_name'])) };
    return result;
  });

  tool('list_affiliates', 'List currently published affiliate IDs and names. Coverage varies by affiliate, sport, market and plan.', {}, async (_, signal) => {
    const result = await request('/affiliates', {}, signal);
    result.data = { affiliates: arrayAt(result.data, 'affiliates')
      .filter((affiliate) => isCanonicalId(affiliate?.affiliate_id)
        && !RETIRED_AFFILIATES.has(affiliate.affiliate_id))
      .map((affiliate) => pick(affiliate, ['affiliate_id', 'affiliate_name'])) };
    return result;
  });

  const marketSummary = (market) => {
    const sports = publicIdArray(market?.sports);
    return {
      ...pick(market, ['id', 'name', 'description', 'period_id', 'live', 'live_variant_id']),
      ...(sports === undefined ? {} : { sports }),
    };
  };

  tool('list_markets', 'Discover catalog definitions, or markets available for one sport and date. Catalog sport/live filters use catalog metadata; date-based discovery uses the fixed availability endpoint. Definitions do not prove open prices.', {
    sport_id: id.optional(),
    date: calendarDate.optional(),
    offset: z.number().int().min(-840).max(840).default(0).describe('Date-boundary offset in minutes; used only with date-based discovery.'),
    live: z.boolean().optional(),
    ...paging,
  }, async (args, signal) => {
    if (args.date !== undefined) {
      if (args.sport_id === undefined) {
        throw new ApiError('invalid_input', 'sport_id is required when date is provided.');
      }
      if (args.live !== undefined) {
        throw new ApiError('invalid_input', 'live cannot be combined with date-based market discovery.');
      }
      const result = await request('/sports/' + args.sport_id + '/markets/' + args.date, {
        hide_closed_markets: 1,
        offset: args.offset,
      }, signal);
      const rows = dateMarketRows(result.data, args.sport_id);
      result.data = pageOf(rows.map(marketSummary), args);
      return result;
    }
    const result = await request('/markets', {}, signal);
    const markets = arrayAt(result.data, null).map(marketSummary)
      .filter((market) => (args.sport_id === undefined || market.sports?.includes(args.sport_id))
        && (args.live === undefined || market.live === args.live));
    result.data = pageOf(markets, args);
    return result;
  });

  const oddsQuery = (args) => ({
    market_ids: args.market_ids.join(','),
    affiliate_ids: args.affiliate_ids.join(','),
    main_line: true,
    hide_closed: true,
    include: 'all_periods',
  });

  tool('list_events', 'Find event IDs for one sport and date. Returns summaries with available market IDs. Defaults to open main lines for prematch markets 1/2/3 and affiliates 19/23. Local pagination refetches the full filtered API response and is metered.', {
    sport_id: id,
    date: calendarDate.describe('Calendar date. Without offset, the day starts at midnight UTC.'),
    offset: z.number().int().min(-840).max(840).default(0).describe('Date-boundary offset in minutes; default UTC.'),
    ...filters,
    ...paging,
  }, async (args, signal) => {
    const result = await request(`/sports/${args.sport_id}/events/${args.date}`, { ...oddsQuery(args), offset: args.offset }, signal);
    result.data = pageOf(arrayAt(result.data, 'events').map(eventSummary), args);
    return result;
  });

  tool('get_main_lines', 'Fetch open, per-affiliate main lines for an event ID from list_events. Preserves participant identity, line value and price updated_at. Add live markets 41/42/43 explicitly. Empty rows do not prove missing coverage. Each local page is a new metered snapshot.', {
    event_id: z.string().regex(/^[A-Za-z0-9-]{1,80}$/).describe('Exact event_id from list_events; never a URL.'),
    ...filters,
    ...paging,
  }, async (args, signal) => {
    const result = await request(`/events/${args.event_id}`, oddsQuery(args), signal);
    const events = arrayAt(result.data, 'events');
    const event = events.find((item) => item.event_id === args.event_id);
    if (!event) throw new ApiError('event_not_found', 'The API returned no matching event. Rediscover the ID and check the date.');
    result.data = { event: eventSummary(event), ...pageOf(mainLineRows(event, args), args) };
    return result;
  });

  const futureMainLineRows = (event, args) => mainLineRows(event, args).map(({ line_id, ...line }) => line);

  const futureEventSummary = (event, args) => {
    const schedule = event?.schedule && typeof event.schedule === 'object' && !Array.isArray(event.schedule)
      ? pick(event.schedule, ['event_name', 'league_name', 'season_year']) : undefined;
    const settlement = event?.settlement && typeof event.settlement === 'object' && !Array.isArray(event.settlement)
      ? Object.fromEntries(Object.entries(event.settlement)
        .filter(([marketId, value]) => isCanonicalId(Number(marketId)) && args.market_ids.includes(Number(marketId))
          && value && typeof value === 'object' && !Array.isArray(value))
        .map(([marketId, value]) => [marketId, pick(value, [
          'status', 'settled_at', 'winning_line', 'winning_participant_id',
        ])])) : undefined;
    return {
      ...pick(event, ['event_id', 'sport_id', 'event_date', 'settle_by', 'event_status']),
      ...(schedule === undefined ? {} : { schedule }),
      ...(settlement === undefined ? {} : { settlement }),
      market_ids: (publicIdArray(Array.isArray(event?.markets)
        ? event.markets.map((market) => market?.market_id) : []) ?? [])
        .filter((marketId) => args.market_ids.includes(marketId)),
      main_lines: futureMainLineRows(event, args),
    };
  };

  tool('list_futures', 'Read one sport\'s scoped futures competition page. Futures are Ultra+ and use opaque cursor pagination; a partial page is not a complete listing.', {
    sport_id: id,
    ...futureFilters,
    limit: z.number().int().min(1).max(200).default(50),
    cursor: opaqueCursor.optional(),
    include_settled: z.boolean().default(false),
  }, async (args, signal) => {
    const query = {
      market_ids: args.market_ids.join(','),
      affiliate_ids: args.affiliate_ids.join(','),
      limit: args.limit,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      ...(args.include_settled ? { include_settled: true } : {}),
    };
    const result = await request('/sports/' + args.sport_id + '/futures', query, signal);
    const events = arrayAt(result.data, 'events');
    if (events.some((event) => !event || typeof event !== 'object' || Array.isArray(event)
      || event.sport_id !== args.sport_id)) {
      throw new ApiError('invalid_response', 'The API returned a futures event outside the requested sport.');
    }
    const meta = result.data?.meta && typeof result.data.meta === 'object' && !Array.isArray(result.data.meta)
      ? pick(result.data.meta, ['count', 'total', 'has_more', 'next_cursor']) : {};
    result.data = { events: events.map((event) => futureEventSummary(event, args)), meta };
    return result;
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await createDataServer().connect(new StdioServerTransport());
  } catch {
    // stdout is reserved for MCP protocol traffic. Never print errors carrying
    // credentials or raw upstream bodies to either output stream.
    process.stderr.write('Unable to start TheRundown data MCP. Use Node 22+ and set THERUNDOWN_API_KEY.\n');
    process.exitCode = 1;
  }
}
