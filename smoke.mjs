import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const NODE = process.execPath;
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const REQUEST_TIMEOUT_MS = 15_000;
const SMOKE_TIMEOUT_MS = 60_000;
const FREE_REQUEST_GAP_MS = 1_000;

export const getSmokeScope = (env = process.env) => {
  const date = env.THERUNDOWN_SMOKE_DATE ?? new Date().toISOString().slice(0, 10);
  const live = env.THERUNDOWN_SMOKE_LIVE ?? '0';
  const futures = env.THERUNDOWN_SMOKE_FUTURES ?? '0';
  const sportId = Number(env.THERUNDOWN_SMOKE_SPORT_ID ?? '3');
  if (!['0', '1'].includes(live) || !['0', '1'].includes(futures)
      || !Number.isInteger(sportId) || sportId < 1 || sportId > 2147483647
      || (live === '1' && futures === '1')) {
    throw new Error('invalid_smoke_scope');
  }
  if (futures === '1') {
    return {
      kind: 'futures',
      sport_id: sportId,
      affiliate_ids: [19, 23],
      market_ids: [1141],
      limit: 50,
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error('invalid_smoke_scope');
  }
  return {
    kind: 'dated',
    sport_id: sportId,
    date,
    affiliate_ids: [19, 23],
    market_ids: live === '1' ? [1, 2, 3, 41, 42, 43] : [1, 2, 3],
  };
};

export const hasExpectedTools = (tools) => {
  const expected = ['list_sports', 'list_affiliates', 'list_markets', 'list_events', 'get_main_lines', 'list_futures'];
  return Array.isArray(tools) && tools.length === expected.length
    && expected.every((name) => tools.some((tool) => tool?.name === name));
};

// Event slates can contain live-variant market IDs even when the smoke scope
// asks only for prematch markets. Select only an event that reports at least
// one requested market ID.
export const selectEventId = (events, marketIds) => {
  if (!Array.isArray(events) || !Array.isArray(marketIds)) return null;
  const requested = new Set(marketIds);
  return events.find((event) => typeof event?.event_id === 'string' && event.event_id.length > 0
    && Array.isArray(event.market_ids)
    && event.market_ids.some((marketId) => requested.has(marketId)))?.event_id ?? null;
};

async function runSmoke() {
  let scope;
  try {
    scope = getSmokeScope();
  } catch {
    process.stderr.write('Use valid THERUNDOWN_SMOKE_DATE, THERUNDOWN_SMOKE_SPORT_ID, THERUNDOWN_SMOKE_LIVE=0 or 1, and THERUNDOWN_SMOKE_FUTURES=0 or 1.\n');
    process.exitCode = 2;
    return;
  }

  if (!process.env.THERUNDOWN_API_KEY?.trim()) {
    process.stderr.write('Set THERUNDOWN_API_KEY privately in your environment.\n');
    process.exitCode = 2;
  } else {
    const transport = new StdioClientTransport({
      command: NODE,
      args: ['server.mjs'],
      cwd: ROOT,
      env: { PATH: process.env.PATH, THERUNDOWN_API_KEY: process.env.THERUNDOWN_API_KEY },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'therundown-data-smoke', version: '0.2.0' }, { capabilities: {} });
    let closed = false;
    let deadline;

    const closeQuietly = async () => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([client.close(), transport.close()]);
    };

    const bounded = (promise, timeoutMs = REQUEST_TIMEOUT_MS) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('smoke_timeout')), timeoutMs);
      promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });

    const stopOnSignal = () => {
      void closeQuietly().finally(() => { process.exitCode = 143; });
    };
    process.once('SIGTERM', stopOnSignal);
    process.once('SIGINT', stopOnSignal);

    const read = (result) => {
      if (result.isError) throw new Error('tool_error');
      const text = result.content?.find((item) => item.type === 'text')?.text;
      if (!text) throw new Error('empty_tool_result');
      return JSON.parse(text);
    };

    try {
      const smokeDeadline = new Promise((_, reject) => {
        deadline = setTimeout(() => {
          void closeQuietly();
          reject(new Error('smoke_deadline'));
        }, SMOKE_TIMEOUT_MS);
      });
      deadline.unref();
      await Promise.race([(async () => {
        await bounded(client.connect(transport));
        const discovered = await bounded(client.listTools({}, { timeout: REQUEST_TIMEOUT_MS }));
        if (!hasExpectedTools(discovered.tools)) throw new Error('unexpected_tool_contract');
        let result;
        if (scope.kind === 'futures') {
          const futures = read(await bounded(client.callTool({
            name: 'list_futures',
            arguments: {
              sport_id: scope.sport_id,
              market_ids: scope.market_ids,
              affiliate_ids: scope.affiliate_ids,
              limit: scope.limit,
            },
          }, undefined, { timeout: REQUEST_TIMEOUT_MS })));
          const events = futures.data?.events ?? [];
          const mainLineCount = events.reduce((count, event) => count + (event.main_lines?.length ?? 0), 0);
          result = {
            status: events.length > 0 && mainLineCount > 0 ? 'ok' : 'inconclusive',
            checked_at: new Date().toISOString(), tools: discovered.tools.length, scope,
            events: events.length, event_id: selectEventId(events, scope.market_ids), main_lines: mainLineCount,
            source_urls: [futures.source_url].filter(Boolean), usage: { list_futures: futures.usage ?? {} },
          };
        } else {
          const events = read(await bounded(client.callTool({
            name: 'list_events',
            arguments: {
              sport_id: scope.sport_id,
              date: scope.date,
              market_ids: scope.market_ids,
              affiliate_ids: scope.affiliate_ids,
            },
          }, undefined, { timeout: REQUEST_TIMEOUT_MS })));
          const firstEvent = selectEventId(events.data?.items, scope.market_ids);
          let lines = null;
          if (firstEvent) {
            // The Free plan permits one Product API request per second. MCP
            // initialization and tool discovery make no Product API request.
            await new Promise((resolve) => setTimeout(resolve, FREE_REQUEST_GAP_MS));
            lines = read(await bounded(client.callTool({
              name: 'get_main_lines',
              arguments: { event_id: firstEvent, market_ids: scope.market_ids, affiliate_ids: scope.affiliate_ids },
            }, undefined, { timeout: REQUEST_TIMEOUT_MS })));
          }
          const eventCount = events.data?.total ?? 0;
          const mainLineCount = lines?.data?.total ?? 0;
          result = {
            status: eventCount > 0 && mainLineCount > 0 ? 'ok' : 'inconclusive',
            checked_at: new Date().toISOString(), tools: discovered.tools.length, scope,
            events: eventCount, event_id: firstEvent ?? null, main_lines: mainLineCount,
            source_urls: [events.source_url, lines?.source_url].filter(Boolean),
            usage: { list_events: events.usage ?? {}, get_main_lines: lines?.usage ?? {} },
          };
        }
        console.log(JSON.stringify(result));
        if (result.status !== 'ok') process.exitCode = 2;
      })(), smokeDeadline]);
    } catch {
      process.stderr.write('Smoke check failed.\n');
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
      process.removeListener('SIGTERM', stopOnSignal);
      process.removeListener('SIGINT', stopOnSignal);
      await closeQuietly();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runSmoke();
}
