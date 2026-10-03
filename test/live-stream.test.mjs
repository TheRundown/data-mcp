import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { captureWebSocket, liveStreamSchemas } from '../live-stream.mjs';

const apiKey = 'isolated-product-key';
const marketArgs = { filters: { event_ids: ['event-test'], market_ids: [1], affiliate_ids: [19] }, duration_ms: 20 };
const subscription = (id = 'p', channel = 'plays', params = { event_ids: ['event-test'] }) => ({ id, channel, params });

async function fixture(t, connected, upgrade) {
  const http = createServer();
  const ws = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  http.on('upgrade', (request, socket, head) => {
    if (upgrade) { upgrade(request, socket); return; }
    ws.handleUpgrade(request, socket, head, (peer) => connected(peer, request));
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const peer of ws.clients) peer.terminate();
    await new Promise((resolve) => ws.close(resolve));
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });
  const port = http.address().port;
  const seen = [];
  class LocalWebSocket extends WebSocket {
    constructor(url, options) {
      seen.push({ url, options });
      const fixed = new URL(url);
      super(`ws://127.0.0.1:${port}${fixed.pathname}${fixed.search}`, options);
    }
  }
  return { WebSocketImpl: LocalWebSocket, seen };
}

test('strict four endpoint schemas reject arbitrary URL, credentials, unsafe scope, retired affiliate and unsupported replay', () => {
  assert.deepEqual(Object.keys(liveStreamSchemas).sort(), ['v1', 'v2', 'v2_hedge', 'v2_markets']);
  for (const args of [
    { ...marketArgs, url: 'https://other.invalid' },
    { ...marketArgs, api_key: apiKey },
    { ...marketArgs, filters: {} },
    { ...marketArgs, filters: { ...marketArgs.filters, affiliate_ids: [27] } },
    { ...marketArgs, duration_ms: 5001 },
    { ...marketArgs, max_frames: 51 },
  ]) assert.equal(liveStreamSchemas.v2_markets.safeParse(args).success, false);
  assert.equal(liveStreamSchemas.v1.safeParse({ filters: { sport_ids: [4], affiliate_ids: [19] } }).success, false);
  assert.equal(liveStreamSchemas.v1.safeParse({ filters: { event_ids: ['event-test'], sport_ids: [0], affiliate_ids: [0] } }).success, true);
  assert.equal(liveStreamSchemas.v2_markets.safeParse({ ...marketArgs, filters: { ...marketArgs.filters, affiliate_ids: [0] } }).success, false);
  for (const sub of [
    subscription('p', 'scores', { event_ids: ['event-test'], market_ids: [1] }),
    subscription('p', 'plays', { event_ids: ['event-test'], snapshot: true, resume: { plays: { 'event-test': 1 } } }),
    subscription('p', 'plays', { event_ids: ['other'], resume: { plays: { 'event-test': 1 } } }),
    subscription('p', 'live', { event_ids: ['event-test'], resume: { plays: { 'event-test': 1 } } }),
    subscription('p', 'stats', { event_ids: ['event-test'], snapshot: true }),
    subscription('p', 'plays', { sport_ids: [4], snapshot: true }),
    subscription('p', 'markets', { event_ids: ['event-test'], market_ids: [1], affiliate_ids: [19], before_sequence: 5 }),
    subscription('p', 'scores', { event_ids: ['event-test'], limit: 5 }),
    subscription('p', 'hedge', { event_ids: ['event-test'], affiliate_ids: [19], participant_ids: [1] }),
  ]) assert.equal(liveStreamSchemas.v2.safeParse({ subscriptions: [sub] }).success, false);
  assert.equal(liveStreamSchemas.v2.safeParse({ subscriptions: [subscription()], actions: [{ action: 'replay', id: 'p' }] }).success, false);
  assert.equal(liveStreamSchemas.v2.safeParse({ subscriptions: [subscription()], actions: [{ action: 'snapshot', id: 'other' }] }).success, false);
});

test('held hedge source is rejected before dedicated or multiplex socket creation', async () => {
  let calls = 0;
  class NeverSocket { constructor() { calls += 1; } }
  const dependencies = { WebSocketImpl: NeverSocket };
  for (const sources of [['propposev'], ['PrOpPoSeV'], ['sportsbook', 'propposev']]) {
    const filters = { event_ids: ['event-test'], affiliate_ids: [19], sources };
    for (const [endpoint, args] of [
      ['v2_hedge', { filters }],
      ['v2', { subscriptions: [subscription('h', 'hedge', filters)] }],
    ]) {
      assert.equal(liveStreamSchemas[endpoint].safeParse(args).success, false);
      await assert.rejects(captureWebSocket({ endpoint, apiKey, args }, dependencies), { code: 'invalid_request' });
    }
  }
  const allowed = { event_ids: ['event-test'], affiliate_ids: [19], sources: ['sportsbook'] };
  assert.equal(liveStreamSchemas.v2_hedge.safeParse({ filters: allowed }).success, true);
  assert.equal(liveStreamSchemas.v2.safeParse({ subscriptions: [subscription('h', 'hedge', allowed)] }).success, true);
  assert.equal(calls, 0);
});

test('missing/expired credential and pre-cancellation make no socket', async () => {
  let calls = 0;
  class NeverSocket { constructor() { calls += 1; } }
  const dependencies = { WebSocketImpl: NeverSocket };
  for (const options of [{ apiKey: '' }, { apiKey, expiresAt: Date.now() - 1 }, { apiKey, signal: AbortSignal.abort() }]) {
    await assert.rejects(captureWebSocket({ endpoint: 'v2_markets', args: marketArgs, ...options }, dependencies));
  }
  assert.equal(calls, 0);
});

test('real loopback upgrade uses exact fixed source, header-only key, no redirects and fragmented JSON', async (t) => {
  const deps = await fixture(t, (peer, request) => {
    assert.equal(request.headers['x-therundown-key'], apiKey);
    assert(!request.url.includes(apiKey));
    peer.send('{"meta":{"type":"market_', { fin: false });
    peer.send('price"},"data":{"affiliate_id":19}}', { fin: true });
  });
  const result = await captureWebSocket({ endpoint: 'v2_markets', apiKey, args: marketArgs }, deps);
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].meta.type, 'market_price');
  assert.equal(result.stop_reason, 'duration_limit');
  assert.equal(result.persistent_stream, false);
  assert.equal(deps.seen[0].options.followRedirects, false);
  assert.equal(deps.seen[0].options.perMessageDeflate, false);
  assert.equal(deps.seen[0].options.maxPayload, 262144);
  assert.equal(new URL(deps.seen[0].url).origin, 'wss://therundown.io');
});

test('V1 and dedicated hedge are real endpoint captures with bounded typed query filters', async (t) => {
  const deps = await fixture(t, (peer) => peer.send(JSON.stringify({ meta: { type: 'event' }, data: { event_id: 'event-test' } })));
  for (const [endpoint, filters] of [
    ['v1', { event_ids: ['event-test'], sport_ids: [4], affiliate_ids: [19], date: '2026-10-03' }],
    ['v2_hedge', { event_ids: ['event-test'], affiliate_ids: [19], sources: ['sportsbook'], include_live: true }],
  ]) {
    const result = await captureWebSocket({ endpoint, apiKey, args: { filters, duration_ms: 10 } }, deps);
    assert.equal(result.frames.length, 1);
    assert.equal(new URL(result.source_url).pathname, `/api/${endpoint === 'v1' ? 'v1/ws' : 'v2/ws/hedge'}`);
  }
});

test('multiplex sends actual subscribe/snapshot/resync/usage/unsubscribe and retains completion/control frames', async (t) => {
  const controls = [];
  const deps = await fixture(t, (peer) => peer.on('message', (raw) => {
    const message = JSON.parse(raw);
    controls.push(message);
    if (message.action === 'subscribe') peer.send(JSON.stringify({ type: 'subscribed', id: message.id }));
    if (['snapshot', 'resync'].includes(message.action)) {
      peer.send(JSON.stringify({ type: 'snapshot', id: message.id, data: { events: [] } }));
      peer.send(JSON.stringify({ type: 'snapshot_complete', id: message.id }));
      if (message.action === 'resync') peer.send(JSON.stringify({ type: 'resync_ack', id: message.id }));
    }
    if (message.action === 'usage') peer.send(JSON.stringify({ meta: { type: 'usage' }, data: { used: 1 } }));
    if (message.action === 'unsubscribe') peer.send(JSON.stringify({ type: 'unsubscribed', id: message.id }));
  }));
  const actions = [{ action: 'snapshot', id: 'p' }, { action: 'resync', id: 'p' }, { action: 'usage' }, { action: 'unsubscribe', id: 'p' }];
  const result = await captureWebSocket({ endpoint: 'v2', apiKey, args: { subscriptions: [subscription()], actions, duration_ms: 40 } }, deps);
  assert.deepEqual(controls.map((item) => item.action), ['subscribe', ...actions.map((item) => item.action)]);
  assert(result.frames.some((frame) => frame.type === 'snapshot_complete'));
  assert(result.frames.some((frame) => frame.type === 'resync_ack'));
  assert(result.frames.some((frame) => frame.type === 'unsubscribed'));
  assert.deepEqual(result.snapshot_complete, ['p']);
  assert.deepEqual(result.resync_ack, ['p']);
});

test('one snapshot completion cannot satisfy multiple requested snapshots or a missing resync ack', async (t) => {
  let first = true;
  const deps = await fixture(t, (peer) => peer.on('message', (raw) => {
    const message = JSON.parse(raw);
    if (message.action === 'subscribe') peer.send(JSON.stringify({ type: 'subscribed', id: message.id }));
    else if (first) { first = false; peer.send(JSON.stringify({ type: 'snapshot_complete', id: message.id })); }
  }));
  const result = await captureWebSocket({ endpoint: 'v2', apiKey, args: { subscriptions: [subscription()], actions: [{ action: 'snapshot', id: 'p' }, { action: 'resync', id: 'p' }], duration_ms: 20 } }, deps);
  assert.deepEqual(result.snapshot_complete, []);
  assert(result.gaps.includes('snapshot_incomplete:p'));
  assert(result.gaps.includes('resync_incomplete:p'));
});

test('resume preserves actual plays cursor/control and explicitly marks truncated replay incomplete', async (t) => {
  let complete = false;
  const deps = await fixture(t, (peer) => peer.on('message', (raw) => {
    const message = JSON.parse(raw);
    assert.deepEqual(message.params.resume, { plays: { 'event-test': 5 } });
    peer.send(JSON.stringify({ type: 'subscribed', id: 'p' }));
    peer.send(JSON.stringify({ type: 'delta', id: 'p', sub_sequence: 1, data: { meta: { type: 'play' }, data: { event_id: 'event-test', sequence: 6 } } }));
    if (complete) peer.send(JSON.stringify({ type: 'resume_complete', id: 'p', cursors: { 'event-test': 6 } }));
  }));
  const args = { subscriptions: [subscription('p', 'plays', { resume: { plays: { 'event-test': 5 } } })], duration_ms: 20 };
  const partial = await captureWebSocket({ endpoint: 'v2', apiKey, args }, deps);
  assert(partial.gaps.includes('resume_incomplete:p'));
  assert.equal(partial.incomplete, true);
  complete = true;
  const finished = await captureWebSocket({ endpoint: 'v2', apiKey, args }, deps);
  assert.deepEqual(finished.resume_complete, { p: { 'event-test': 6 } });
  assert.equal(finished.incomplete, false);
});

test('secret redaction and whole-frame blocked-affiliate filtering include nested hedge legs', async (t) => {
  const deps = await fixture(t, (peer) => {
    peer.send(JSON.stringify({ meta: { type: 'hedge_updated' }, data: { bets: [{ affiliate_id: 19 }, { affiliate_id: 27 }] } }));
    peer.send(JSON.stringify({ [apiKey]: { message: apiKey, nested: ['prefix' + apiKey] }, data: { affiliate_id: 19 } }));
  });
  const result = await captureWebSocket({ endpoint: 'v2_markets', apiKey, args: marketArgs }, deps);
  assert.equal(result.filtered_frames, 1);
  assert.equal(result.frames.length, 1);
  assert(!JSON.stringify(result).includes(apiKey));
  assert(result.gaps.includes('blocked_affiliate_filtered'));
});

test('keyed retired price/line/source maps drop whole aggregates; private fields are removed', async (t) => {
  const deps = await fixture(t, (peer) => {
    for (const key of ['prices', 'lines', 'line_periods', 'affiliate_source_ids', 'sportsbooks', 'affiliates']) {
      peer.send(JSON.stringify({ data: { aggregate: { [key]: { 19: { price: 100 }, 27: { price: -100 } } } } }));
    }
    peer.send(JSON.stringify({ type: 'delta', affiliate: { id: 27 }, price: 150 }));
    peer.send(JSON.stringify({ data: { source_id: 'public-source', api_key: 'other-credential', provider_id: 'private-provider', internal: { debug: 'private' }, bets: [{ affiliate_id: 19 }] } }));
  });
  const result = await captureWebSocket({ endpoint: 'v2_markets', apiKey, args: marketArgs }, deps);
  assert.equal(result.filtered_frames, 7);
  assert.equal(result.frames.length, 1);
  assert.deepEqual(result.frames[0].data, { source_id: 'public-source', bets: [{ affiliate_id: 19 }] });
  assert(!JSON.stringify(result).includes('other-credential'));
});

test('per-channel options stay strict and numeric tool offset is serialized as the upstream string', async (t) => {
  const received = [];
  const deps = await fixture(t, (peer) => peer.on('message', (raw) => {
    const message = JSON.parse(raw); received.push(message);
    peer.send(JSON.stringify({ type: 'subscribed', id: message.id }));
    peer.send(JSON.stringify({ type: 'snapshot_complete', id: message.id }));
  }));
  await captureWebSocket({ endpoint: 'v2', apiKey, args: { subscriptions: [subscription('s', 'scores', { sport_ids: [4], date: '2026-10-03', offset: 300, snapshot: true })], duration_ms: 10 } }, deps);
  assert.equal(received[0].params.offset, '300');
  assert.equal(liveStreamSchemas.v2.safeParse({ subscriptions: [subscription('s', 'scores', { event_ids: ['event-test'], participant_type: 'TYPE_TEAM' })] }).success, false);
});

test('aggregate byte cap discards crossing frame and marks capture incomplete', async (t) => {
  const deps = await fixture(t, (peer) => {
    peer.send(JSON.stringify({ text: 'a'.repeat(140000) }));
    peer.send(JSON.stringify({ text: 'b'.repeat(140000) }));
  });
  const result = await captureWebSocket({ endpoint: 'v2_markets', apiKey, args: marketArgs }, deps);
  assert.equal(result.frames.length, 1);
  assert.equal(result.stop_reason, 'byte_limit');
  assert(result.gaps.includes('byte_limit'));
  assert(Buffer.byteLength(JSON.stringify(result.frames)) <= 262144);
});

test('deep malformed structure rejects safely; reserved subscription IDs do not mutate result prototypes', async (t) => {
  let deep = true;
  const deps = await fixture(t, (peer) => {
    if (deep) { peer.send('{"data":' + '['.repeat(100) + '0' + ']'.repeat(100) + '}'); return; }
    peer.on('message', () => {
      peer.send(JSON.stringify({ type: 'subscribed', id: '__proto__' }));
      peer.send(JSON.stringify({ type: 'resume_complete', id: '__proto__', cursors: { 'event-test': 5 } }));
    });
  });
  await assert.rejects(captureWebSocket({ endpoint: 'v2_markets', apiKey, args: marketArgs }, deps), { code: 'invalid_response' });
  deep = false;
  const result = await captureWebSocket({ endpoint: 'v2', apiKey, args: { subscriptions: [subscription('__proto__', 'plays', { resume: { plays: { 'event-test': 5 } } })], duration_ms: 10 } }, deps);
  assert.equal(Object.hasOwn(result.resume_complete, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(result.resume_complete), Object.prototype);
});

test('frame limit counts filtered/control frames, closes actual socket and does not silently truncate snapshot', async (t) => {
  let closed;
  const close = new Promise((resolve) => { closed = resolve; });
  const deps = await fixture(t, (peer) => {
    peer.once('close', closed);
    peer.send(JSON.stringify({ type: 'subscribed', id: 'p' }));
    peer.send(JSON.stringify({ type: 'snapshot', id: 'p', data: { events: [] } }));
    peer.send(JSON.stringify({ type: 'snapshot_complete', id: 'p' }));
  });
  const result = await captureWebSocket({ endpoint: 'v2', apiKey, args: { subscriptions: [subscription('p', 'plays', { event_ids: ['event-test'], snapshot: true })], max_frames: 2, duration_ms: 100 } }, deps);
  assert.equal(result.received_frames, 2);
  assert.equal(result.stop_reason, 'frame_limit');
  assert(result.gaps.includes('snapshot_incomplete:p'));
  await close;
});

test('oversized individual frame, invalid JSON and binary data return sanitized errors', async (t) => {
  let mode = 'large';
  const deps = await fixture(t, (peer) => {
    if (mode === 'large') peer.send(JSON.stringify({ text: 'x'.repeat(262145) }));
    if (mode === 'invalid') peer.send(`not-json-${apiKey}`);
    if (mode === 'binary') peer.send(Buffer.from('{}'));
  });
  for (mode of ['large', 'invalid', 'binary']) {
    await assert.rejects(captureWebSocket({ endpoint: 'v2_markets', apiKey, args: marketArgs }, deps), (error) => !error.message.includes(apiKey) && ['response_too_large', 'invalid_response'].includes(error.code));
  }
});

test('expiry and cancellation close quiet sockets; no persistent session leaks', async (t) => {
  const deps = await fixture(t, () => {});
  const controller = new AbortController();
  const call = captureWebSocket({ endpoint: 'v2_markets', apiKey, args: { ...marketArgs, duration_ms: 5000 }, signal: controller.signal }, deps);
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(call, { code: 'request_aborted' });
  await assert.rejects(captureWebSocket({ endpoint: 'v2_markets', apiKey, args: { ...marketArgs, duration_ms: 5000 }, expiresAt: Date.now() + 20 }, deps), { code: 'credential_expired' });
});

test('HTTP401/403/429 and redirect handshake never read bodies or follow another origin', async (t) => {
  let status = 401;
  const deps = await fixture(t, () => {}, (request, socket) => {
    socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\nRetry-After: 3\r\nLocation: https://evil.invalid/${apiKey}\r\n\r\n`);
  });
  for (status of [401, 403, 429, 302]) {
    await assert.rejects(captureWebSocket({ endpoint: 'v2_markets', apiKey, args: marketArgs }, deps), (error) => error.status === (status === 302 ? 503 : status) && error.retryAfter === (status === 429 ? 3 : null) && !error.message.includes(apiKey));
  }
  assert.equal(deps.seen.length, 4);
});

test('quiet window returns empty observation; non-acknowledging close is forcibly terminated', async () => {
  const sockets = [];
  class QuietSocket extends EventEmitter {
    constructor() { super(); this.readyState = WebSocket.CONNECTING; sockets.push(this); queueMicrotask(() => { this.readyState = WebSocket.OPEN; this.emit('open'); }); }
    close() { this.readyState = WebSocket.CLOSING; }
    terminate() { this.terminated = true; this.readyState = WebSocket.CLOSED; this.emit('close'); }
  }
  const result = await captureWebSocket({ endpoint: 'v2_markets', apiKey, args: { ...marketArgs, duration_ms: 5 } }, { WebSocketImpl: QuietSocket });
  assert.equal(result.frames.length, 0);
  assert.equal(result.stop_reason, 'duration_limit');
  assert.equal(sockets[0].terminated, true);
});

test('stalled handshake is forcibly closed within the separate two-second connection budget', async () => {
  let terminated = false;
  class StalledSocket extends EventEmitter {
    constructor() { super(); this.readyState = WebSocket.CONNECTING; }
    terminate() { terminated = true; this.readyState = WebSocket.CLOSED; this.emit('close'); }
  }
  const started = Date.now();
  await assert.rejects(captureWebSocket({ endpoint: 'v2_markets', apiKey, args: marketArgs }, { WebSocketImpl: StalledSocket }), { code: 'upstream_unavailable' });
  assert(terminated);
  assert(Date.now() - started < 3000);
});

test('cancellation or expiry during graceful closing discards the captured buffer', async () => {
  class ClosingSocket extends EventEmitter {
    constructor() { super(); this.readyState = WebSocket.CONNECTING; queueMicrotask(() => { this.readyState = WebSocket.OPEN; this.emit('open'); this.emit('message', Buffer.from('{"data":{"price":100}}'), false); }); }
    close() { this.readyState = WebSocket.CLOSING; }
    terminate() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  }
  const deps = { WebSocketImpl: ClosingSocket };
  const controller = new AbortController();
  const call = captureWebSocket({ endpoint: 'v2_markets', apiKey, args: { ...marketArgs, duration_ms: 5 }, signal: controller.signal }, deps);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(call, { code: 'request_aborted' });
  await assert.rejects(captureWebSocket({ endpoint: 'v2_markets', apiKey, args: { ...marketArgs, duration_ms: 5 }, expiresAt: Date.now() + 20 }, deps), { code: 'credential_expired' });
});

test('sub-sequence gaps are explicit; global sequence is never used as a gap/replay cursor', async (t) => {
  const deps = await fixture(t, (peer) => {
    peer.send(JSON.stringify({ type: 'delta', id: 'p', sub_sequence: 1, sequence: 500 }));
    peer.send(JSON.stringify({ type: 'delta', id: 'p', sub_sequence: 3, sequence: 2 }));
  });
  const result = await captureWebSocket({ endpoint: 'v2_markets', apiKey, args: marketArgs }, deps);
  assert(result.gaps.includes('sub_sequence_gap:p'));
  assert.deepEqual(result.frames.map((frame) => frame.sequence), [500, 2]);
});
