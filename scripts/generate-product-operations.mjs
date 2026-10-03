#!/usr/bin/env node
// Generate the reviewed, static public operation catalog. No network access.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const base = new URL('../', import.meta.url);
const raw = await readFile(new URL('product-operation-source.json', base), 'utf8');
const source = JSON.parse(raw);
const numericIDs = /(?:_id$|ID$|Id$|^id$)/;
const forbidden = /^(?:key|api_key|client_secret|access_token|refresh_token|authorization|headers?|url|origin|method)$/i;

function schemaPolicy(input, name, location) {
  const schema = structuredClone(input ?? { type: 'string' });
  if (schema.type === 'object') {
    schema.additionalProperties = false;
    schema.properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => {
      if (forbidden.test(key)) throw new Error('Forbidden caller credential/routing field');
      return [key, schemaPolicy(value, key, 'body')];
    }));
  } else if (schema.type === 'array') {
    schema.maxItems = Math.min(schema.maxItems ?? (name === 'legs' ? 25 : 50), name === 'affiliate_ids' ? 10 : name === 'legs' ? 25 : 50);
    schema.items = schemaPolicy(schema.items, name === 'affiliate_ids' ? 'affiliate_id' : name, location);
    schema.uniqueItems = name !== 'legs';
  } else if (schema.type === 'integer' || schema.type === 'number') {
    schema.minimum ??= name === 'offset' ? -840 : numericIDs.test(name) ? (['participant_id', 'period_id', 'market_participant_id'].includes(name) ? 0 : 1) : 0;
    schema.maximum ??= name === 'offset' ? (location === 'query' ? 1000000 : 840) : schema.format === 'int64' || name === 'before_sequence' ? Number.MAX_SAFE_INTEGER : 2147483647;
    if (name === 'offset' && /date|sport|event/.test(location)) schema.maximum = 840;
    if (name === 'year' || name === 'season_year') Object.assign(schema, { minimum: 1900, maximum: 2200 });
    if (name === 'limit') schema.maximum = Math.min(schema.maximum, 5000);
    if (['limit', 'all_limit', 'sample_limit', 'min_peers', 'window_minutes'].includes(name)) schema.minimum = Math.max(schema.minimum, 1);
    if (name === 'affiliate_id') schema.excludedValues = [27];
  } else if (schema.type === 'string') {
    if (name === 'date') schema.format = 'date';
    schema.maxLength ??= name === 'cursor' ? 4096 : name === 'line' || name === 'min_percent' ? 32 : 256;
    if (location === 'path' && schema.format !== 'date') {
      schema.minLength ??= 1;
      schema.maxLength = Math.min(schema.maxLength, 80);
      schema.pattern ??= '^[A-Za-z0-9-]+$';
    }
    if (name.endsWith('_ids')) {
      schema.minLength = 1;
      schema.maxLength = 4096;
      schema.csv = { type: name === 'event_ids' ? 'event_id' : 'integer',
                     maxItems: name === 'market_ids' || name === 'stats_ids' ? 12 : name === 'affiliate_ids' ? 10 : name === 'player_ids' ? 6 : 50,
                     minimum: name === 'affiliate_ids' || name === 'participant_ids' ? 0 : 1,
                     maximum: name === 'market_line_price_ids' ? Number.MAX_SAFE_INTEGER : 2147483647,
                     unique: true, excludedValues: name === 'affiliate_ids' ? [27] : [] };
    }
    if (name === 'event_id' || name === 'last_event_uuid') {
      schema.maxLength = 80;
      schema.minLength = 1;
      schema.pattern = '^[A-Za-z0-9-]+$';
    }
    if (name === 'min_percent') schema.pattern = '^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)$';
    if (name === 'line') schema.pattern = '^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)$';
    if (name === 'cursor') schema.minLength = 1;
  }
  return schema;
}

const operations = source.operations.map((operation) => {
  if (!['GET', 'POST'].includes(operation.method) || !/^\/api\/v[12]\//.test(operation.path)
      || /\/(?:admin|internal|push|assistant|ws)(?:\/|$)/.test(operation.path)) throw new Error('Non-public operation');
  const parameters = operation.parameters.map((parameter) => {
    if (!['path', 'query'].includes(parameter.in) || forbidden.test(parameter.name)) throw new Error('Unsafe parameter');
    const schema = schemaPolicy(parameter.schema, parameter.name, parameter.in);
    if (parameter.name === 'affiliate_ids' && schema.csv) {
      const scoresOnly = ['v2GetEventsBySportAndDate', 'v2GetEventByID', 'v2GetEventOpeners',
        'v2GetEventClosing', 'v2GetOpenersBySportAndDate', 'v2GetClosingBySportAndDate'].includes(operation.operationId);
      schema.csv.minimum = scoresOnly ? 0 : 1;
      schema.csv.zeroSentinelOnly = scoresOnly;
    }
    if (parameter.name === 'offset' && !operation.path.includes('/hedge')) Object.assign(schema, { minimum: -840, maximum: 840 });
    if (parameter.name === 'type' && operation.path.includes('/hedge') && !operation.path.endsWith('/{id}')) {
      Object.assign(schema, { enum: ['2ways', 'mainlines', 'props', '3ways', 'middles', 'posev', 'openev'], default: '2ways' });
    }
    return { ...parameter, required: parameter.required === true, schema };
  });
  const body = operation.request_body?.content?.['application/json']?.schema;
  if (operation.method === 'POST' && !body) throw new Error('Calculation body schema required');
  return { id: operation.operationId, name: operation.operationId, method: operation.method,
           path: operation.path, title: operation.summary,
           description: [operation.summary, operation.description,
             'Read-only Product data or price calculation. Use returned canonical IDs. Access, delay and metered usage follow your connected account; never infer coverage from an empty result.',
             'One bounded request, no background polling or automatic retry. Affiliate 27 is excluded. No wagers, account changes or guarantee of returns.',
             operation.method === 'POST' ? 'POST computes same-book prices from existing public prices; it does not submit a bet.' : ''].filter(Boolean).join(' '),
           parameters, body: body ? schemaPolicy(body, 'body', 'body') : null,
           body_required: operation.request_body?.required === true,
           public_contract_source: operation.public_contract_source,
           published_docs_spec: operation.published_docs_spec,
           existing_mcp_tools: operation.mcp_tools, baseline_actions: operation.baseline_actions,
           annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
           annotation_justifications: { readOnlyHint: 'Reads public customer Product data or calculates from existing prices; does not change account or place wagers.',
             destructiveHint: 'No delete/update/write or wager submission.', openWorldHint: 'Queries current real-world sports events and prices from the fixed TheRundown Product API.' } };
});
if (new Set(operations.map((operation) => operation.id)).size !== operations.length) throw new Error('Duplicate operation ID');
const catalog = { schema_version: 1, source_sha256: createHash('sha256').update(raw).digest('hex'),
  fixed_origin: 'https://therundown.io', affiliate_exclusions: [27],
  policy_notes: ['Strict caller path/query/body only; no caller URL, method, header or credentials.',
    'Declared public limits retained; missing scalar/string/list limits receive explicit bounded MCP policies.',
    'Market/stat list max12, affiliate list max10, player list max6, other ID lists max50; nonnumeric event IDs remain bounded strings.',
    'Optional public book/market filters remain optional. Normal Product entitlement enforcement still applies.',
    'Retired V1 hedge operations are never dispatched. #11832 HOLD is not lifted; experimental propposev is excluded.'],
  operations, compatibility_aliases: source.compatibility_aliases, retired_operations: source.retired_operations };
const coverage = { schema_version: 1, canonical_operations: operations.length,
  canonical_GET: operations.filter((operation) => operation.method === 'GET').length,
  canonical_POST_read_calculations: operations.filter((operation) => operation.method === 'POST').length,
  compatibility_aliases: source.compatibility_aliases.length, retired_excluded: source.retired_operations.length,
  published_spec_operations: operations.filter((operation) => operation.published_docs_spec).length,
  existing_mcp_path_patterns: operations.filter((operation) => operation.existing_mcp_tools.length).length,
  baseline_actions_operations: operations.filter((operation) => operation.baseline_actions).length,
  operation_ids: operations.map((operation) => operation.id) };
for (const [name, value] of [['product-operations.json', catalog], ['product-operation-coverage.json', coverage]]) {
  const text = JSON.stringify(value, null, 2) + '\n';
  const target = new URL(name, base);
  if (process.argv.includes('--check')) {
    if (await readFile(target, 'utf8') !== text) throw new Error('Generated public operation catalog is stale');
  } else await writeFile(target, text);
}
console.log(JSON.stringify({ status: process.argv.includes('--check') ? 'catalog_current' : 'catalog_generated', ...coverage, operation_ids: undefined }));
