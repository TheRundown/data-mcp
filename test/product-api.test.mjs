import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import catalog from '../product-operations.json' with { type: 'json' };
import { operationDescriptors, compatibilityAliases, retiredOperations, buildProductRequest } from '../product-api.mjs';

const descriptor = (id) => operationDescriptors.find((operation) => operation.id === id);
const leg = { event_id: 'e25f52783bd6d9b0ad2bd4bfbdc6e77a', market_id: 1, period_id: 0, participant_id: 0, participant_type: 0, line: '-1.5' };
function example(schema) {
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'integer' || schema.type === 'number') return Math.max(schema.minimum ?? 1, 1);
  if (schema.type === 'boolean') return false;
  if (schema.type === 'array') return Array.from({ length: schema.minItems ?? 1 }, () => example(schema.items));
  if (schema.type === 'object') return Object.fromEntries((schema.required ?? []).map((key) => [key, example(schema.properties[key])]));
  if (schema.format === 'date') return '2026-10-03';
  if (schema.format === 'date-time') return '2026-10-03T12:00:00Z';
  if (schema.csv) return schema.csv.type === 'event_id' ? leg.event_id : '19';
  return 'a'.repeat(Math.max(schema.minLength ?? 1, 1));
}
function argsFor(operation) {
  const args = {};
  for (const parameter of operation.parameters) {
    if (parameter.required || parameter.in === 'path') {
      args[parameter.in] ??= {};
      args[parameter.in][parameter.name] = example(parameter.schema);
    }
  }
  if (operation.body_required) args.body = { legs: [leg, { ...leg, event_id: 'another-event' }], affiliate_ids: [19, 23] };
  return args;
}

test('all 75 public operations are separately described and execute one fixed method/path request', async () => {
  assert.equal(operationDescriptors.length, 75);
  assert.equal(new Set(operationDescriptors.map((item) => item.name)).size, 75);
  assert.equal(operationDescriptors.filter((item) => item.name.includes('discover') || item.name.includes('query_product')).length, 0);
  for (const operation of catalog.operations) {
    const tool = descriptor(operation.id);
    assert.equal(tool.inputSchema.constructor.name, 'ZodObject');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.ok(tool.annotationJustifications.readOnlyHint);
    const signal = new AbortController().signal;
    const returned = { data: { source_id: 'public-id', arbitrary_public_field: { preserved: true } } };
    const calls = [];
    assert.equal(await tool.execute(argsFor(operation), async (...args) => { calls.push(args); return returned; }, signal), returned);
    assert.equal(calls.length, 1);
    const [path, query, passedSignal, options] = calls[0];
    assert.match(path, /^\/api\/v[12]\//);
    assert.equal(path.includes('{'), false);
    assert.equal(path.includes('?'), false);
    assert.equal(passedSignal, signal);
    assert.equal(options.method, operation.method);
    assert.equal(typeof query, 'object');
  }
});

test('compatibility aliases map to canonical tools; all retired operations stay excluded', () => {
  assert.equal(compatibilityAliases.length, 47);
  assert.equal(retiredOperations.length, 12);
  for (const alias of compatibilityAliases) assert.ok(descriptor(alias.operationId), alias.path);
  for (const retired of retiredOperations) {
    assert.equal(retired.status, 410);
    assert.equal(catalog.operations.some((operation) => operation.method === retired.method && operation.path === retired.path), false);
    assert.throws(() => buildProductRequest(retired.path, {}));
  }
  for (const id of ['https://example.org', '/api/v2/sports', 'query_product_api', 'unknown']) assert.throws(() => buildProductRequest(id, {}));
});

test('strict schemas reject caller routing, credentials, encoded path bypasses and negative IDs', () => {
  for (const field of ['url', 'method', 'headers', 'key', 'authorization', 'origin', 'body', 'query']) {
    assert.throws(() => buildProductRequest('v2GetSports', { [field]: 'caller' }), field);
  }
  for (const eventID of ['../sports', '%2fadmin', 'event?key=hidden', 'event#fragment', 'event\n', 'é']) {
    assert.throws(() => buildProductRequest('v2GetEventByID', { path: { eventID } }), eventID);
  }
  for (const sportID of [0, -1, 1.5, '4', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildProductRequest('v2GetTeamsBySport', { path: { sportID } }));
  }
  assert.throws(() => buildProductRequest('v2GetEventByID', { path: { eventID: 'safe', extra: 1 } }));
  for (const field of ['key', 'api_key', 'affiliate_id', 'hideClosed', 'limit']) {
    assert.throws(() => buildProductRequest('v2GetEventByID', { path: { eventID: 'safe' }, query: { [field]: 1 } }), field);
  }
});

test('path and query dates reject impossible dates and accept leap days', () => {
  for (const date of ['2026-02-29', '2024-02-30', '2026-13-01', '0000-01-01', '2026-1-03', '2026-10-03T00:00:00Z', '2026-10-03%2f']) {
    assert.throws(() => buildProductRequest('v2GetSteamersBySportAndDate', { path: { sport_id: 4, date } }));
    assert.throws(() => buildProductRequest('v2GetSteamers', { query: { sport_id: 4, date } }));
  }
  assert.equal(buildProductRequest('v2GetSteamers', { query: { sport_id: 4, date: '2024-02-29' } }).query.date, '2024-02-29');
});

test('ID lists exclude affiliate27, duplicates, mixed zero sentinel and oversized lists', () => {
  const args = { path: { eventID: 'safe' } };
  for (const affiliate_ids of ['27', '19,27', '19,19', '0,19', '00', '019', '19,', '19, 23', '-1', '1,2,3,4,5,6,7,8,9,10,11']) {
    assert.throws(() => buildProductRequest('v2GetEventByID', { ...args, query: { affiliate_ids } }), affiliate_ids);
  }
  assert.equal(buildProductRequest('v2GetEventByID', { ...args, query: { affiliate_ids: '0' } }).query.affiliate_ids, '0');
  assert.equal(buildProductRequest('v2GetEventByID', { ...args, query: { affiliate_ids: '19,23' } }).query.affiliate_ids, '19,23');
  assert.throws(() => buildProductRequest('v2GetFuturesForSport', { path: { sportID: 4 }, query: { affiliate_ids: '0' } }));
  for (const market_ids of ['1,1', '0', '1,2,3,4,5,6,7,8,9,10,11,12,13']) {
    assert.throws(() => buildProductRequest('v2GetEventByID', { ...args, query: { market_ids } }));
  }
  assert.throws(() => buildProductRequest('v2GetOutliers', { query: { sport_id: 4, date: '2026-10-03', affiliate_id: 27 } }));
});

test('full public snapshot switches remain available with bounded pagination', () => {
  const request = buildProductRequest('v2GetEventsBySportAndDate', { path: { sportID: 4, date: '2026-10-03' }, query: { main_line: 'false', hide_closed: 'false', include: 'all_periods', affiliate_ids: '19,23' } });
  assert.equal(request.query.main_line, 'false');
  assert.equal(request.query.hide_closed, 'false');
  assert.equal(request.query.include, 'all_periods');
  for (const limit of [0, -1, 5001, Infinity, NaN]) {
    assert.throws(() => buildProductRequest('v2GetMarketsDelta', { query: { last_id: 1, limit } }));
  }
  assert.throws(() => buildProductRequest('v2GetEventsBySportAndDate', { path: { sportID: 4, date: '2026-10-03' }, query: { offset: 841 } }));
  assert.throws(() => buildProductRequest('v2GetHedgeOpportunities', { query: { type: 'propposev' } }));
  assert.equal(buildProductRequest('v2GetHedgeOpportunities', {}).query.type, '2ways');
});

test('POST price calculations accept full-game zero period and finite signed/zero lines, reject negative IDs and body injection', () => {
  for (const operationId of ['v2GetParlayBook', 'v2GetBestParlayBook']) {
    for (const line of ['-1.5', '0', '+1.5', '.5']) {
      const request = buildProductRequest(operationId, { body: { legs: [{ ...leg, line }, { ...leg, event_id: 'other' }], affiliate_ids: [19, 23], limit: 100 } });
      assert.equal(request.method, 'POST');
      assert.equal(request.body.legs[0].period_id, 0);
      assert.equal(request.body.legs[0].line, line);
    }
    for (const field of ['period_id', 'participant_id', 'participant_type', 'market_participant_id']) {
      assert.throws(() => buildProductRequest(operationId, { body: { legs: [{ ...leg, [field]: -1 }, leg] } }), field);
    }
    for (const line of ['NaN', 'Infinity', '1e10', '', '1;drop', '1.2.3']) {
      assert.throws(() => buildProductRequest(operationId, { body: { legs: [{ ...leg, line }, leg] } }), line);
    }
    for (const affiliate_ids of [[27], [19, 27], [19, 19], [0]]) assert.throws(() => buildProductRequest(operationId, { body: { legs: [leg, leg], affiliate_ids } }));
    assert.throws(() => buildProductRequest(operationId, { body: { legs: [leg] } }));
    assert.throws(() => buildProductRequest(operationId, { body: { legs: Array(26).fill(leg) } }));
    assert.throws(() => buildProductRequest(operationId, { body: { legs: [leg, leg], headers: {} } }));
    assert.throws(() => buildProductRequest(operationId, { body: { legs: [{ ...leg, key: 'hidden' }, leg] } }));
  }
});

test('failure propagates after exactly one request, without automatic retry', async () => {
  let calls = 0;
  const failure = new Error('controlled failure');
  await assert.rejects(descriptor('v2GetSports').execute({}, async () => { calls++; throw failure; }), (error) => error === failure);
  assert.equal(calls, 1);
});

test('static catalog and coverage reproduce from the reviewed public source', () => {
  const output = execFileSync(process.execPath, ['scripts/generate-product-operations.mjs', '--check'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(JSON.parse(output).canonical_operations, 75);
});

test('reviewable tool JSON schemas expose permitted enums, public defaults, strict objects and dates', () => {
  for (const tool of operationDescriptors) assert.equal(z.toJSONSchema(tool.inputSchema, { io: 'input' }).additionalProperties, false);
  const hedge = z.toJSONSchema(descriptor('v2GetHedgeOpportunities').inputSchema, { io: 'input' });
  const type = hedge.properties.query.properties.type;
  assert.deepEqual(type.allOf[0].enum, ['2ways', 'mainlines', 'props', '3ways', 'middles', 'posev', 'openev']);
  assert.equal(type.default, '2ways');
  assert.equal(hedge.properties.query.properties.limit.default, 20);
  const dates = z.toJSONSchema(descriptor('v2GetEventsBySportAndDate').inputSchema, { io: 'input' });
  assert.equal(dates.properties.path.properties.date.format, 'date');
  assert.match(dates.properties.query.properties.affiliate_ids.description, /maximum 10/);
});

test('stats and player filters retain published/source caps instead of widening silent truncation', () => {
  assert.throws(() => buildProductRequest('v2GetPlayerStatsByEvent', { path: { eventID: 'safe' }, query: { stats_ids: '1,2,3,4,5,6,7,8,9,10,11,12,13' } }));
  assert.throws(() => buildProductRequest('v2GetPlayerStatsByEvent', { path: { eventID: 'safe' }, query: { player_ids: '1,2,3,4,5,6,7' } }));
  assert.equal(buildProductRequest('v2GetPlayerStatsByEvent', { path: { eventID: 'safe' }, query: { player_ids: '1,2,3,4,5,6', stats_ids: '1,2,3,4,5,6,7,8,9,10,11,12' } }).query.player_ids, '1,2,3,4,5,6');
});


test('history timestamps reject normalized overflow clocks that the Product RFC3339 parser rejects', () => {
  for (const from of ['2026-10-03T24:00:00Z', '2026-10-03T12:60:00Z', '2026-10-03T12:00:60Z', '2026-02-30T00:00:00Z']) {
    assert.throws(() => buildProductRequest('v2GetMarketLinePriceHistory', { query: { market_line_price_ids: '1', from } }));
  }
  assert.equal(buildProductRequest('v2GetMarketLinePriceHistory', { query: { market_line_price_ids: '1', from: '2026-10-03T12:00:00-05:00' } }).query.from, '2026-10-03T12:00:00-05:00');
});
