import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AGENT_BRIEF, FIRST_CONVERSATION, createDataServer } from '../server.mjs';
import { getSmokeScope, hasExpectedTools, selectEventId } from '../smoke.mjs';

const NODE22 = process.execPath;
const EXAMPLE_DIR = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'offline-test-key-should-never-leak';

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function oversizedResponse() {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/json' } });
}

async function connected(fetchImpl, options = {}) {
  const server = createDataServer({ apiKey: KEY, fetchImpl, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'offline-test-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, clientTransport, serverTransport };
}

async function closeConnection(connection) {
  await Promise.allSettled([connection.client.close(), connection.server.close()]);
}

function textResult(result) {
  return result.content?.find((item) => item.type === 'text')?.text ?? '';
}

function jsonResult(result) {
  return JSON.parse(textResult(result));
}

test('smoke scope defaults to free-tier full-game markets without live markets', () => {
  assert.deepEqual(getSmokeScope({ THERUNDOWN_SMOKE_DATE: '2026-09-06' }), {
    kind: 'dated',
    sport_id: 3,
    date: '2026-09-06',
    affiliate_ids: [19, 23],
    market_ids: [1, 2, 3],
  });
});

test('smoke scope adds the explicit live market set only when opted in', () => {
  assert.deepEqual(getSmokeScope({
    THERUNDOWN_SMOKE_DATE: '2026-09-06',
    THERUNDOWN_SMOKE_LIVE: '1',
  }), {
    kind: 'dated',
    sport_id: 3,
    date: '2026-09-06',
    affiliate_ids: [19, 23],
    market_ids: [1, 2, 3, 41, 42, 43],
  });
});

test('smoke scope rejects invalid dates and live opt-in values', () => {
  for (const env of [
    { THERUNDOWN_SMOKE_DATE: '2026-02-30' },
    { THERUNDOWN_SMOKE_DATE: '2026-09-06/../secret' },
    { THERUNDOWN_SMOKE_DATE: '2026-09-06', THERUNDOWN_SMOKE_LIVE: 'yes' },
  ]) {
    assert.throws(() => getSmokeScope(env), /invalid_smoke_scope/);
  }
});

test('smoke scope supports explicit dated sport and an opt-in scoped futures request', () => {
  assert.deepEqual(getSmokeScope({
    THERUNDOWN_SMOKE_DATE: 'not-used-by-futures', THERUNDOWN_SMOKE_SPORT_ID: '40', THERUNDOWN_SMOKE_FUTURES: '1',
  }), {
    kind: 'futures', sport_id: 40, affiliate_ids: [19, 23], market_ids: [1141], limit: 50,
  });
  assert.throws(() => getSmokeScope({ THERUNDOWN_SMOKE_LIVE: '1', THERUNDOWN_SMOKE_FUTURES: '1' }), /invalid_smoke_scope/);
});

test('smoke tool contract requires exactly the six expected unique names in any order', () => {
  const expected = [
    'list_sports', 'list_affiliates', 'list_markets', 'list_events', 'get_main_lines', 'list_futures',
  ];
  assert.equal(hasExpectedTools(expected.slice().reverse().map((name) => ({ name }))), true);
  assert.equal(hasExpectedTools(expected.slice(0, 4).map((name) => ({ name }))), false);
  assert.equal(hasExpectedTools([
    ...expected.slice(0, 4).map((name) => ({ name })),
    { name: 'list_events' },
  ]), false);
  assert.equal(hasExpectedTools([
    ...expected.slice(0, 4).map((name) => ({ name })),
    { name: 'unexpected_tool' },
  ]), false);
  assert.equal(hasExpectedTools([
    ...expected.slice(0, 4).map((name) => ({ name })),
    null,
  ]), false);
});

test('smoke selects an event with a requested market, not the first event with any market', () => {
  const events = [
    { event_id: '9f5c566c27a3a1778e6a401b05b4939c', market_ids: [41, 42, 43] },
    { event_id: '013ce103d5fb30ea3e1742fc01b79804', market_ids: [1, 2, 3] },
    { event_id: '4ec77ad9f2445c631b5209c68204f4e1', market_ids: [1, 2, 3] },
  ];
  assert.equal(selectEventId(events, [1, 2, 3]), '013ce103d5fb30ea3e1742fc01b79804');
  assert.equal(selectEventId(events, [1, 2, 3, 41, 42, 43]), '9f5c566c27a3a1778e6a401b05b4939c');
});

test('smoke leaves the event unset when no summary reports a requested market', () => {
  assert.equal(selectEventId([
    { event_id: '', market_ids: [1, 2, 3] },
    { event_id: 'live-only', market_ids: [41, 42, 43] },
    { event_id: 'without-markets', market_ids: [] },
  ], [1, 2, 3]), null);
});

async function withServer(fetchImpl, callback, options = {}) {
  const connection = await connected(fetchImpl, options);
  try {
    return await callback(connection.client);
  } finally {
    await closeConnection(connection);
  }
}

test('SDK discovery lists all tools and preserves usage metadata', async () => {
  let calls = 0;
  await withServer(async (url, options) => {
    calls += 1;
    assert.equal(url.pathname, '/api/v2/sports');
    assert.equal(options.headers['X-TheRundown-Key'], KEY);
    assert.equal(url.searchParams.has('key'), false);
    return response({ sports: [{ sport_id: 3, sport_name: 'MLB' }] }, {
      headers: { 'X-Datapoints': '0', 'X-Data-Delay-Seconds': '0' },
    });
  }, async (client) => {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), [
      'list_sports', 'list_affiliates', 'list_markets', 'list_events', 'get_main_lines', 'list_futures',
    ]);
    const result = await client.callTool({ name: 'list_sports', arguments: {} });
    const value = jsonResult(result);
    assert.deepEqual(value.data.sports, [{ sport_id: 3, sport_name: 'MLB' }]);
    assert.equal(value.usage['x-datapoints'], '0');
    assert.equal(value.usage['x-data-delay-seconds'], '0');
    assert.match(value.source_url, /^https:\/\/therundown\.io\/api\/v2\/sports$/);
    assert.ok(value.retrieved_at);
  });
  assert.equal(calls, 1);
});

test('list_affiliates excludes retired affiliate 27', async () => {
  await withServer(async (url) => {
    assert.equal(url.pathname, '/api/v2/affiliates');
    return response({ affiliates: [
      { affiliate_id: 27, affiliate_name: 'Retired affiliate', status: 'inactive' },
      { affiliate_id: '27', affiliate_name: 'Malformed retired affiliate' },
      { affiliate_id: 0, affiliate_name: 'Invalid identity' },
      { affiliate_id: 28, affiliate_name: 'Published affiliate', status: 'active' },
    ] });
  }, async (client) => {
    const value = jsonResult(await client.callTool({ name: 'list_affiliates', arguments: {} }));
    assert.deepEqual(value.data.affiliates, [{ affiliate_id: 28, affiliate_name: 'Published affiliate' }]);
  });
});

test('redacts credentials that need JSON escaping', async () => {
  const escapedKey = 'quote"key\\slash';
  await withServer(async () => response({ sports: [{ sport_id: 3, sport_name: escapedKey }] }), async (client) => {
    const result = await client.callTool({ name: 'list_sports', arguments: {} });
    const text = textResult(result);
    assert.equal(text.includes(escapedKey), false);
    assert.equal(text.includes(JSON.stringify(escapedKey).slice(1, -1)), false);
    assert.equal(text.includes('[REDACTED]'), true);
  }, { apiKey: escapedKey });
});

test('redacts URL-encoded credential reflections', async () => {
  const encodedKey = 'redaction/key?with space';
  const percentEncoded = encodeURIComponent(encodedKey);
  const formEncoded = percentEncoded.replaceAll('%20', '+');
  const lowercaseEscapes = percentEncoded.replaceAll('%2F', '%2f');
  const mixedCaseEscapes = percentEncoded.replaceAll('%2F', '%2f').replaceAll('%20', '%20');
  await withServer(async () => response({ sports: [
    { sport_id: 3, sport_name: percentEncoded },
    { sport_id: 4, sport_name: formEncoded },
    { sport_id: 5, sport_name: lowercaseEscapes },
    { sport_id: 6, sport_name: mixedCaseEscapes },
  ] }), async (client) => {
    const text = textResult(await client.callTool({ name: 'list_sports', arguments: {} }));
    assert.equal(text.includes(percentEncoded), false);
    assert.equal(text.includes(formEncoded), false);
    assert.equal(text.includes(lowercaseEscapes), false);
    assert.equal(text.includes(mixedCaseEscapes), false);
    assert.equal(text.includes('[REDACTED]'), true);
  }, { apiKey: encodedKey });
});

test('trims whitespace from the key before sending and redacting it', async () => {
  const normalizedKey = 'normalized-key';
  const paddedKey = `  ${normalizedKey}\t`;
  await withServer(async (_url, options) => {
    assert.equal(options.headers['X-TheRundown-Key'], normalizedKey);
    return response({ sports: [{ sport_id: 3, sport_name: `source-${normalizedKey}` }] });
  }, async (client) => {
    const result = await client.callTool({ name: 'list_sports', arguments: {} });
    const text = textResult(result);
    assert.equal(text.includes(normalizedKey), false);
    assert.equal(text.includes(paddedKey), false);
    assert.equal(text.includes('[REDACTED]'), true);
  }, { apiKey: paddedKey });
});

test('event summaries allowlist score fields while redacting numeric-looking keys', async () => {
  const numericKey = '123';
  await withServer(async () => response({ events: [{
    event_id: 'evt-123',
    sport_id: 123,
    score: {
      event_status: 'STATUS_SCHEDULED', score_away: 0, score_home: 0,
      game_clock: 0, display_clock: { unprojected_detail: 'must-not-escape' }, game_period: 0,
      event_status_detail: 'Scheduled', updated_at: '2026-09-06T00:00:00Z',
      unprojected_detail: { nested: 'must-not-escape' },
    },
    teams: [{ team_id: 123, name: '123 team', mascot: { nested: 'must-not-escape' }, is_home: true, is_away: null }],
    markets: [{ market_id: 1 }, { market_id: { nested: 'must-not-escape' } }],
  }] }), async (client) => {
    const result = await client.callTool({
      name: 'list_events',
      arguments: { sport_id: 123, date: '2026-09-06' },
    });
    const text = textResult(result);
    const value = JSON.parse(text);
    const item = value.data.items[0];
    assert.equal(item.sport_id, 123);
    assert.deepEqual(item.score, {
      event_status: 'STATUS_SCHEDULED', score_away: 0, score_home: 0,
      game_clock: 0, game_period: 0,
      event_status_detail: 'Scheduled', updated_at: '2026-09-06T00:00:00Z',
    });
    assert.equal(text.includes('must-not-escape'), false);
    assert.deepEqual(item.teams, [{ team_id: 123, name: '[REDACTED] team', is_home: true, is_away: null }]);
    assert.deepEqual(item.market_ids, [1]);
    assert.equal(text.includes('evt-[REDACTED]'), true);
  }, { apiKey: numericKey });
});

test('event summaries require array-shaped team inputs', async () => {
  await withServer(async () => response({ events: [
    {
      event_id: 'fallback-teams', teams_normalized: { unprojected_detail: 'must-not-escape' },
      teams: [{ team_id: 1, name: 'Fallback team', is_home: true }], markets: [],
    },
    {
      event_id: 'malformed-teams', teams: { unprojected_detail: 'must-not-escape' }, markets: [],
    },
  ] }), async (client) => {
    const text = textResult(await client.callTool({
      name: 'list_events', arguments: { sport_id: 3, date: '2026-09-06' },
    }));
    const value = JSON.parse(text);
    assert.deepEqual(value.data.items.map((event) => event.teams), [
      [{ team_id: 1, name: 'Fallback team', is_home: true }],
      [],
    ]);
    assert.equal(text.includes('must-not-escape'), false);
  });
});

test('list_markets accepts the documented bare-array shape and filters locally', async () => {
  await withServer(async (url) => {
    assert.equal(url.pathname, '/api/v2/markets');
    assert.equal(url.search, '');
    return response([
      { id: 1, name: 'Moneyline', live: false, sports: [3], period_id: 1 },
      {
        id: 41, name: 'Live Moneyline', description: { nested: 'must-not-escape' }, live: true,
        sports: [3, '3', { nested: 'must-not-escape' }, 0], period_id: 1,
      },
    ]);
  }, async (client) => {
    const result = await client.callTool({
      name: 'list_markets',
      arguments: { sport_id: 3, live: true, limit: 1 },
    });
    assert.deepEqual(jsonResult(result).data, {
      items: [{ id: 41, name: 'Live Moneyline', period_id: 1, live: true, sports: [3] }],
      total: 1,
      page: 1,
      limit: 1,
      next_page: null,
    });
  });
});

test('list_markets discovers a sport-date availability response without changing catalog calls', async () => {
  await withServer(async (url) => {
    assert.equal(url.pathname, '/api/v2/sports/40/markets/2026-09-07');
    assert.equal(url.searchParams.get('hide_closed_markets'), '1');
    assert.equal(url.searchParams.get('offset'), '60');
    assert.equal(url.searchParams.has('key'), false);
    return response({ 40: [{ id: 1141, name: 'Tournament Winner', period_id: 0, live_variant_id: null }] });
  }, async (client) => {
    const value = jsonResult(await client.callTool({
      name: 'list_markets', arguments: { sport_id: 40, date: '2026-09-07', offset: 60 },
    }));
    assert.deepEqual(value.data, {
      items: [{ id: 1141, name: 'Tournament Winner', period_id: 0, live_variant_id: null }],
      total: 1, page: 1, limit: 50, next_page: null,
    });
    assert.equal(textResult(await client.callTool({
      name: 'list_markets', arguments: { date: '2026-09-07' },
    })).includes('sport_id is required'), true);
    assert.equal((await client.callTool({
      name: 'list_markets', arguments: { sport_id: 40, date: '2026-09-07', live: true },
    })).isError, true);
  });
});

test('list_markets treats an empty date availability object as empty and rejects mixed keys or malformed rows', async () => {
  const bodies = [{}, { 40: [] }, { 41: [] }, { 40: {} }, { 40: [], 41: [] }, { 40: [null] }, { 40: [1] }, { 40: [{ id: '1141' }] }];
  await withServer(async (url) => {
    assert.equal(url.pathname, '/api/v2/sports/40/markets/2026-09-07');
    return response(bodies.shift());
  }, async (client) => {
    const empty = jsonResult(await client.callTool({
      name: 'list_markets', arguments: { sport_id: 40, date: '2026-09-07' },
    }));
    assert.deepEqual(empty.data, { items: [], total: 0, page: 1, limit: 50, next_page: null });
    const sportEmpty = jsonResult(await client.callTool({
      name: 'list_markets', arguments: { sport_id: 40, date: '2026-09-07' },
    }));
    assert.deepEqual(sportEmpty.data, empty.data);
    for (let index = 2; index < 8; index += 1) {
      const malformed = await client.callTool({
        name: 'list_markets', arguments: { sport_id: 40, date: '2026-09-07' },
      });
      assert.equal(malformed.isError, true);
      assert.match(textResult(malformed), /unexpected response shape/);
    }
  });
});

test('list_sports projects all 36 catalog identities without a tool-side sport allowlist', async () => {
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 30, 31, 32, 33, 34, 38, 39, 40, 41];
  await withServer(async () => response({
    sports: ids.map((sport_id) => ({ sport_id, sport_name: 'Sport ' + sport_id })),
  }), async (client) => {
    const value = jsonResult(await client.callTool({ name: 'list_sports', arguments: {} }));
    assert.deepEqual(value.data.sports.map((sport) => sport.sport_id), ids);
  });
});

test('list_futures scopes PGA, F1, and a team sport, preserves cursor metadata, and projects only public open main lines', async () => {
  const seen = [];
  await withServer(async (url) => {
    seen.push(url);
    const sportId = Number(url.pathname.split('/')[4]);
    assert.equal(url.searchParams.get('market_ids'), '1141');
    assert.equal(url.searchParams.get('affiliate_ids'), '19,23');
    assert.equal(url.searchParams.get('limit'), '2');
    assert.equal(url.searchParams.has('key'), false);
    return response({
      meta: { count: 1, total: 3, has_more: true, next_cursor: 'opaque-next', internal: 'must-not-escape' },
      events: [{
        event_id: 'future-' + sportId, sport_id: sportId, event_date: '2026-09-07T00:00:00Z',
        settle_by: '2026-12-31T00:00:00Z', event_status: 'STATUS_SCHEDULED',
        schedule: { event_name: 'Competition ' + sportId, league_name: 'League', season_year: 2026, raw: 'must-not-escape' },
        settlement: {
          1141: { status: 'pending', settled_at: null, winning_line: null, winning_participant_id: null, raw: 'must-not-escape' },
          999: { status: 'pending', raw: 'must-not-escape' },
        },
        markets: [{
          market_id: 1141, name: 'tournament_winner', period_id: 0,
          participants: [{ id: 1, type: 'TYPE_TEAM', name: 'Selection', lines: [{ id: 'line-1', prices: {
            19: { price: 500, is_main_line: true, closed_at: '', updated_at: '2026-09-07T00:00:00Z' },
            23: { price: 600, is_main_line: true, closed_at: '2026-09-07T00:00:01Z' },
            27: { price: 700, is_main_line: true },
          } }, { id: 'line-2', prices: { 19: { price: 0.0001, is_main_line: true } } }, {
            id: 'line-3', prices: { 23: { affiliate_id: 19, price: 600, is_main_line: true } },
          }] }],
        }, { market_id: 999, participants: [] }],
      }],
    });
  }, async (client) => {
    for (const sport_id of [40, 41, 2]) {
      const result = await client.callTool({
        name: 'list_futures',
        arguments: { sport_id, market_ids: [1141], affiliate_ids: [19, 23], limit: 2, cursor: 'opaque-cursor', include_settled: true },
      });
      assert.equal(result.isError ?? false, false, textResult(result));
      const value = jsonResult(result);
      assert.deepEqual(value.data.meta, { count: 1, total: 3, has_more: true, next_cursor: 'opaque-next' });
      assert.equal(value.data.events[0].sport_id, sport_id);
      assert.deepEqual(value.data.events[0].schedule, {
        event_name: 'Competition ' + sport_id, league_name: 'League', season_year: 2026,
      });
      assert.deepEqual(value.data.events[0].settlement, {
        1141: { status: 'pending', settled_at: null, winning_line: null, winning_participant_id: null },
      });
      assert.deepEqual(value.data.events[0].market_ids, [1141]);
      assert.deepEqual(value.data.events[0].main_lines.map((line) => line.affiliate_id), [19]);
      assert.equal('line_id' in value.data.events[0].main_lines[0], false);
      assert.equal(textResult(result).includes('must-not-escape'), false);
    }
  });
  assert.equal(seen.length, 3);
  assert.equal(seen[0].searchParams.get('cursor'), 'opaque-cursor');
  assert.equal(seen[0].searchParams.get('include_settled'), 'true');
});

test('list_futures rejects retired affiliates, mismatched scope, and malformed event envelopes', async () => {
  let calls = 0;
  await withServer(async (url) => {
    calls += 1;
    assert.equal(url.searchParams.get('market_ids'), '1141');
    assert.equal(url.searchParams.get('affiliate_ids'), '19,23');
    if (calls === 1) return response({ events: [{ event_id: 'wrong-sport', sport_id: 41, markets: [] }] });
    return response({ events: { raw: 'must-not-escape' } });
  }, async (client) => {
    const wrongScope = await client.callTool({ name: 'list_futures', arguments: { sport_id: 40 } });
    assert.equal(wrongScope.isError, true);
    assert.match(textResult(wrongScope), /outside the requested sport/);
    const malformed = await client.callTool({ name: 'list_futures', arguments: { sport_id: 40 } });
    assert.equal(malformed.isError, true);
    assert.match(textResult(malformed), /unexpected response shape/);
    assert.equal(textResult(malformed).includes('must-not-escape'), false);
    const retired = await client.callTool({ name: 'list_futures', arguments: { sport_id: 40, affiliate_ids: [27] } });
    assert.equal(retired.isError, true);
  });
  assert.equal(calls, 2);
});

test('main-line rows drop non-scalar projected values', async () => {
  await withServer(async () => response({ events: [{
    event_id: 'evt-1', markets: [{
      market_id: 1, name: { nested: 'must-not-escape' }, period_id: { nested: 'must-not-escape' },
      participants: [{
        id: { nested: 'must-not-escape' }, type: ['must-not-escape'], name: { nested: 'must-not-escape' },
        lines: [{
          id: { nested: 'must-not-escape' }, value: { nested: 'must-not-escape' },
          prices: { 19: { price: -110, is_main_line: true, updated_at: { nested: 'must-not-escape' } } },
        }],
      }],
    }],
  }] }), async (client) => {
    const text = textResult(await client.callTool({ name: 'get_main_lines', arguments: { event_id: 'evt-1' } }));
    const value = JSON.parse(text);
    assert.deepEqual(value.data.items, [{
      market_id: 1, participant: {}, line_value: null, affiliate_id: 19, price: -110, is_main_line: true,
    }]);
    assert.equal(text.includes('must-not-escape'), false);
  });
});

test('list_events sends bounded filters and handles the { events } wrapper', async () => {
  await withServer(async (url, options) => {
    assert.equal(url.pathname, '/api/v2/sports/3/events/2026-09-06');
    assert.equal(url.searchParams.get('market_ids'), '1,41');
    assert.equal(url.searchParams.get('affiliate_ids'), '19,23');
    assert.equal(url.searchParams.get('main_line'), 'true');
    assert.equal(url.searchParams.get('hide_closed'), 'true');
    assert.equal(url.searchParams.get('include'), 'all_periods');
    assert.equal(url.searchParams.get('offset'), '60');
    assert.equal(options.redirect, 'error');
    assert.equal(url.searchParams.has('key'), false);
    return response({ events: [{
      event_id: 'evt-1', sport_id: 3, event_date: '2026-09-06T18:00:00Z',
      teams_normalized: [{ team_id: 10, name: 'Away', is_away: true }],
      markets: [{ market_id: 1 }],
    }] }, { headers: { 'x-datapoints-used': '12' } });
  }, async (client) => {
    const result = await client.callTool({
      name: 'list_events',
      arguments: { sport_id: 3, date: '2026-09-06', offset: 60, market_ids: [1, 41] },
    });
    const value = jsonResult(result);
    assert.deepEqual(value.data.items[0], {
      event_id: 'evt-1',
      sport_id: 3,
      event_date: '2026-09-06T18:00:00Z',
      teams: [{ team_id: 10, name: 'Away', is_away: true }],
      market_ids: [1],
    });
    assert.equal(value.usage['x-datapoints-used'], '12');
  });
});

test('get_main_lines preserves each book line and excludes retired 27', async () => {
  let seenUrl;
  await withServer(async (url) => {
    seenUrl = url;
    return response({ events: [{
      event_id: 'evt-1', sport_id: 3, teams: [{ team_id: 10, name: 'Away' }],
      markets: [{
        market_id: 1, name: 'Moneyline', period_id: 1,
        participants: [{ id: 'away', type: 'team', name: 'Away', lines: [
          { id: 'line-1', value: -1.5, prices: {
            19: { price: -110, is_main_line: true, updated_at: '2026-09-06T18:00:00Z' },
            23: { price: -105, is_main_line: true, updated_at: '2026-09-06T18:01:00Z' },
            27: { price: -100, is_main_line: true, updated_at: '2026-09-06T18:02:00Z' },
          } },
          { id: 'line-2', value: -2.5, prices: {
            19: { price: 105, is_main_line: false, updated_at: '2026-09-06T18:00:00Z' },
          } },
        ] }],
      }],
    }] }, { headers: { 'x-datapoints': '3', 'x-datapoints-remaining': '97' } });
  }, async (client) => {
    const result = await client.callTool({
      name: 'get_main_lines',
      arguments: { event_id: 'evt-1', affiliate_ids: [19, 23] },
    });
    assert.ok(!result.isError, textResult(result));
    assert.equal(seenUrl.pathname, '/api/v2/events/evt-1');
    assert.equal(seenUrl.searchParams.get('market_ids'), '1,2,3');
    assert.equal(seenUrl.searchParams.get('affiliate_ids'), '19,23');
    const value = jsonResult(result);
    assert.deepEqual(value.data.items, [
      {
        market_id: 1,
        market_name: 'Moneyline',
        period_id: 1,
        participant: { id: 'away', type: 'team', name: 'Away' },
        line_id: 'line-1',
        line_value: -1.5,
        affiliate_id: 19,
        price: -110,
        is_main_line: true,
        updated_at: '2026-09-06T18:00:00Z',
      },
      {
        market_id: 1,
        market_name: 'Moneyline',
        period_id: 1,
        participant: { id: 'away', type: 'team', name: 'Away' },
        line_id: 'line-1',
        line_value: -1.5,
        affiliate_id: 23,
        price: -105,
        is_main_line: true,
        updated_at: '2026-09-06T18:01:00Z',
      },
    ]);
    assert.equal(value.usage['x-datapoints'], '3');
    assert.equal(value.usage['x-datapoints-remaining'], '97');
  });
});

test('invalid dates, traversal, unknown arguments, and oversized arrays fail before fetch', async () => {
  let calls = 0;
  await withServer(async () => {
    calls += 1;
    return response({ events: [] });
  }, async (client) => {
    const invalid = [
      { name: 'list_events', arguments: { sport_id: 3, date: '2026-02-30' } },
      { name: 'list_events', arguments: { sport_id: 3, date: '2026-09-06', extra: true } },
      { name: 'list_events', arguments: { sport_id: 3, date: '2026-09-06', market_ids: Array.from({ length: 13 }, (_, i) => i + 1) } },
      { name: 'get_main_lines', arguments: { event_id: '../secret' } },
      { name: 'get_main_lines', arguments: { event_id: 'evt-1', affiliate_ids: Array.from({ length: 11 }, (_, i) => i + 1) } },
    ];
    for (const request of invalid) {
      const result = await client.callTool(request);
      assert.equal(result.isError, true);
      assert.match(textResult(result), /MCP error -32602: Input validation error/);
    }
  });
  assert.equal(calls, 0);
});

test('401, 403, and 429 errors are sanitized while retaining status, usage, and retry-after', async () => {
  for (const status of [401, 403, 429]) {
    await withServer(async () => response({ secret: KEY, body: 'upstream raw body' }, {
      status,
      headers: { 'x-datapoints': '9', 'retry-after': status === 429 ? '30' : 'soon' },
    }), async (client) => {
      const result = await client.callTool({ name: 'list_sports', arguments: {} });
      assert.equal(result.isError, true);
      const text = textResult(result);
      assert.equal(text.includes(KEY), false);
      assert.equal(text.includes('upstream raw body'), false);
      const value = JSON.parse(text);
      assert.equal(value.error, 'upstream_error');
      assert.equal(value.status, status);
      assert.equal(value.usage['x-datapoints'], '9');
      if (status === 429) assert.equal(value.retry_after, 30);
      else assert.equal(value.retry_after, null);
      assert.equal(value.plan, null);
      assert.equal(value.missing_entitlement, null);
      assert.equal(value.remaining_points, null);
      assert.deepEqual(result.structuredContent, value);
    });
  }
});

test('brief resource and initialize instructions share the first conversation without API requests', async () => {
  await withServer(async () => { throw new Error('No request expected'); }, async (client) => {
    const listed = await client.listResources();
    assert.deepEqual(listed.resources.map(({ uri }) => uri), ['therundown://brief']);
    const resource = await client.readResource({ uri: 'therundown://brief' });
    assert.equal(resource.contents[0].mimeType, 'text/markdown');
    assert.equal(resource.contents[0].text, AGENT_BRIEF);
    assert.equal(client.getInstructions(), AGENT_BRIEF);
    assert.ok(AGENT_BRIEF.includes(FIRST_CONVERSATION));
    const tools = await client.listTools();
    for (const tool of tools.tools) assert.match(tool.description.split('. ')[1], /^Do not /);
  });
});

test('403 reports only recognized public entitlement details without guessing the current plan', async () => {
  await withServer(async () => response({
    error: 'Futures markets require Ultra plan or higher',
    token: KEY, internal_context: 'private-upstream-value',
  }, { status: 403 }), async (client) => {
    const result = await client.callTool({ name: 'list_futures', arguments: { sport_id: 40 } });
    const value = jsonResult(result);
    assert.equal(value.plan, null);
    assert.equal(value.required_plan, 'ultra');
    assert.equal(value.missing_entitlement, 'futures');
    assert.equal(value.remaining_points, null);
    assert.equal(value.retry_after, null);
    assert.match(value.source_url, /^https:\/\/therundown\.io\/api\/v2\/sports\/40\/futures\?/);
    assert.equal(textResult(result).includes('private-upstream-value'), false);
    assert.equal(textResult(result).includes(KEY), false);
  });
});

test('429 distinguishes monthly caps and preserves header plan, remaining points, and retry dates', async () => {
  const retryDate = new Date(Date.now() + 60_000).toUTCString();
  await withServer(async () => response({ error: 'Monthly data point limit reached' }, {
    status: 429,
    headers: { 'X-Tier': 'free', 'X-Datapoints-Remaining': '45',
      'X-Datapoints-Monthly-Remaining': '0', 'Retry-After': retryDate },
  }), async (client) => {
    const value = jsonResult(await client.callTool({ name: 'list_events', arguments: { sport_id: 3, date: '2026-09-09' } }));
    assert.equal(value.plan, 'free');
    assert.equal(value.limit_reason, 'monthly_data_points');
    assert.equal(value.remaining_points, 45);
    assert.equal(value.monthly_remaining_points, 0);
    assert.ok(value.retry_after >= 58 && value.retry_after <= 60);
  });
});

test('malformed, oversized, and unrecognized error bodies preserve HTTP failure and hide body content', async () => {
  const bodies = ['not-json-private', JSON.stringify({ error: { toString: 'private' }, plan: 'enterprise' }),
    JSON.stringify({ error: 'private'.repeat(20_000) })];
  for (const body of bodies) {
    await withServer(async () => new Response(body, { status: 403 }), async (client) => {
      const result = await client.callTool({ name: 'list_sports', arguments: {} });
      const value = jsonResult(result);
      assert.equal(value.status, 403);
      assert.equal(value.plan, null);
      assert.equal(value.missing_entitlement, null);
      assert.equal(textResult(result).includes('private'), false);
    });
  }
});

test('empty dated events explain the exact scope while retaining usage and pagination', async () => {
  for (const offset of [0, 300]) {
    await withServer(async () => response({ events: [] }, { headers: { 'X-Datapoints': '0' } }), async (client) => {
      const value = jsonResult(await client.callTool({ name: 'list_events', arguments: {
        sport_id: 3, date: '2026-09-09', offset,
      } }));
      assert.equal(value.empty.code, 'no_results');
      assert.match(value.empty.message, /sport 3 on 2026-09-09/);
      assert.equal(value.empty.scope.date_boundary_offset_minutes, offset);
      assert.equal(value.empty.scope.timezone, offset === 0 ? 'UTC' : undefined);
      assert.deepEqual(value.empty.scope.market_ids, [1, 2, 3]);
      assert.deepEqual(value.empty.scope.affiliate_ids, [19, 23]);
      assert.deepEqual(value.data, { items: [], total: 0, page: 1, limit: 50, next_page: null });
      assert.equal(value.usage['x-datapoints'], '0');
    });
  }
});

test('an empty local page does not report an empty slate', async () => {
  await withServer(async () => response({ events: [{ event_id: 'evt-1', sport_id: 3 }] }), async (client) => {
    const value = jsonResult(await client.callTool({ name: 'list_events', arguments: {
      sport_id: 3, date: '2026-09-09', page: 2,
    } }));
    assert.equal(value.empty.code, 'page_out_of_range');
    assert.equal(value.data.total, 1);
    assert.match(value.empty.message, /Use an earlier page/);
    assert.doesNotMatch(value.empty.message, /No events/);
  });
});

test('timeout, cancellation, oversized body, and redirects remain bounded and sanitized', async () => {
  await withServer(async () => {
    throw new DOMException('timed out', 'TimeoutError');
  }, async (client) => {
    const result = await client.callTool({ name: 'list_sports', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textResult(result), /timed out, was cancelled, or failed/);
    assert.equal(textResult(result).includes(KEY), false);
  }, { timeoutMs: 5 });

  let upstreamAborted = false;
  await withServer(async (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => {
      upstreamAborted = true;
      reject(new DOMException('cancelled', 'AbortError'));
    }, { once: true });
  }), async (client) => {
    const controller = new AbortController();
    const pending = client.callTool({ name: 'list_sports', arguments: {} }, undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending);
  }, { timeoutMs: 100 });
  assert.equal(upstreamAborted, true);

  await withServer(async () => oversizedResponse(), async (client) => {
    const result = await client.callTool({ name: 'list_sports', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textResult(result), /response_too_large/);
    assert.match(textResult(result), /4 MiB/);
  });

  await withServer(async (_url, options) => {
    assert.equal(options.redirect, 'error');
    throw new TypeError('redirect disallowed');
  }, async (client) => {
    const result = await client.callTool({ name: 'list_sports', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textResult(result), /request_failed/);
    assert.equal(textResult(result).includes('redirect disallowed'), false);
  });
});

test('stdio initialize and list_tools do not call upstream', async () => {
  const transport = new StdioClientTransport({
    command: NODE22,
    args: ['server.mjs'],
    cwd: EXAMPLE_DIR,
    env: { PATH: process.env.PATH, THERUNDOWN_API_KEY: KEY },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 6);
  assert.equal(transport.pid > 0, true);
  await client.close();
});

test('stdio startup without a key fails with bounded sanitized stderr', async () => {
  const child = spawn(NODE22, ['server.mjs'], {
    cwd: EXAMPLE_DIR,
    env: { PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.match(stderr, /Unable to start TheRundown data MCP/);
  assert.equal(stderr.includes('THERUNDOWN_API_KEY'), true);
  assert.equal(stderr.includes(KEY), false);
  assert.equal(stderr.length < 500, true);
});
