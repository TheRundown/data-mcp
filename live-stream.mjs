import WebSocket from 'ws';
import { z } from 'zod';
import { publicProductData } from './public-response.mjs';

const MAX_BYTES = 256 * 1024;
const HANDSHAKE_MS = 2000;
const CLOSE_MS = 100;
const PATHS = Object.freeze({ v1: '/api/v1/ws', v2_markets: '/api/v2/ws/markets', v2: '/api/v2/ws', v2_hedge: '/api/v2/ws/hedge' });
const ids = (max) => z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(max);
const eventId = z.string().regex(/^[A-Za-z0-9-]{1,80}$/);
const eventIds = z.array(eventId).min(1).max(5);
const affiliates = ids(10).refine((values) => !values.includes(27), 'Affiliate 27 is unavailable.');
const v1Ids = (max) => z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).min(1).max(max);
const v1Affiliates = v1Ids(10).refine((values) => !values.includes(27), 'Affiliate 27 is unavailable.');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}, 'Use a real calendar date.');
const observe = { duration_ms: z.number().int().min(1).max(5000).default(5000), max_frames: z.number().int().min(1).max(50).default(50) };
const common = { sport_ids: ids(3).optional(), event_ids: eventIds.optional() };
const price = { market_ids: ids(12).optional(), affiliate_ids: affiliates.optional(), main_line: z.boolean().optional() };
const hedgeSource = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
  .refine((value) => value.toLowerCase() !== 'propposev', 'This source is unavailable.');
const hedge = { event_ids: eventIds.optional(), affiliate_ids: affiliates.optional(), sources: z.array(hedgeSource).min(1).max(5).optional(), min_percent: z.number().min(0).max(100).optional(), include_live: z.boolean().optional(), include_links: z.boolean().optional() };
const v1Filters = z.strictObject({ ...common, sport_ids: v1Ids(3).optional(), affiliate_ids: v1Affiliates.optional(), date: date.optional() });
const marketFilters = z.strictObject({ ...common, ...price });
const hedgeFilters = z.strictObject(hedge);
const resume = z.strictObject({ plays: z.record(eventId, z.number().int().positive().max(4294967295)).refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 5) });
const params = z.strictObject({ ...common, ...price, ...hedge, date: date.optional(), offset: z.number().int().min(-840).max(840).optional(), snapshot: z.boolean().optional(), participant_ids: ids(12).optional(), participant_type: z.enum(['TYPE_TEAM', 'TYPE_PLAYER', 'TYPE_RESULT']).optional(), hide_no_markets: z.boolean().optional(), event_status: z.string().regex(/^[A-Za-z0-9_, -]{1,80}$/).optional(), exclude_status: z.string().regex(/^[A-Za-z0-9_, -]{1,80}$/).optional(), limit: z.number().int().min(1).max(500).optional(), before_sequence: z.number().int().positive().max(4294967295).optional(), after_sequence: z.number().int().positive().max(4294967295).optional(), resume: resume.optional() });
const subscriptionId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const subscription = z.strictObject({ id: subscriptionId, channel: z.enum(['markets', 'scores', 'plays', 'stats', 'live', 'live_game_state', 'game_state', 'futures', 'hedge']), params });
const action = z.strictObject({ action: z.enum(['snapshot', 'resync', 'usage', 'unsubscribe']), id: subscriptionId.optional(), params: params.optional() });

function scopeErrors(value, ctx) {
  const add = (message) => ctx.addIssue({ code: 'custom', message });
  if (value.endpoint === 'v1') {
    if (!value.filters.event_ids?.length || !value.filters.affiliate_ids?.length) add('V1 capture requires event_ids and affiliate_ids; sport/date do not scope its V2 frames.');
  } else if (value.endpoint === 'v2_markets') {
    if (!(value.filters.event_ids?.length || value.filters.sport_ids?.length) || !value.filters.market_ids?.length || !value.filters.affiliate_ids?.length) add('Market capture requires event/sport, market and affiliate filters.');
  } else if (value.endpoint === 'v2_hedge') {
    if (!value.filters.event_ids?.length || !value.filters.affiliate_ids?.length) add('Hedge capture requires event_ids and affiliate_ids.');
  } else {
    const seen = new Map();
    for (const sub of value.subscriptions) {
      if (seen.has(sub.id)) add('Subscription IDs must be unique.');
      seen.set(sub.id, sub);
      validateSubscription(sub, add);
    }
    for (const control of value.actions) {
      if (control.action !== 'usage' && !seen.has(control.id)) add('Actions must address an included subscription.');
      if (control.action === 'usage' && (control.id || control.params)) add('Usage takes no subscription parameters.');
      if (control.action === 'unsubscribe' && control.params) add('Unsubscribe takes no params.');
      const sub = seen.get(control.id);
      if (sub && ['snapshot', 'resync'].includes(control.action)) validateSubscription({ ...sub, params: { ...sub.params, ...control.params, snapshot: true, resume: undefined } }, add);
      if (control.params?.resume) add('Resume belongs only on an initial plays subscription.');
    }
  }
}

function validateSubscription({ channel, params: p }, add) {
  const filterKeys = {
    markets: ['sport_ids', 'event_ids', 'market_ids', 'affiliate_ids', 'main_line', 'snapshot', 'date', 'offset', 'participant_ids', 'participant_type', 'hide_no_markets', 'event_status', 'exclude_status'],
    futures: ['sport_ids', 'event_ids', 'market_ids', 'affiliate_ids', 'main_line', 'snapshot'],
    scores: ['sport_ids', 'event_ids', 'snapshot', 'date', 'offset', 'event_status', 'exclude_status'],
    plays: ['sport_ids', 'event_ids', 'snapshot', 'limit', 'before_sequence', 'after_sequence', 'resume'],
    stats: ['sport_ids', 'event_ids'],
    live: ['sport_ids', 'event_ids', 'snapshot', 'date', 'offset', 'event_status', 'exclude_status', 'limit', 'before_sequence', 'after_sequence'],
    hedge: ['event_ids', 'affiliate_ids', 'sources', 'min_percent', 'include_live', 'include_links'],
  };
  const canonical = ['live_game_state', 'game_state'].includes(channel) ? 'live' : channel;
  if (Object.entries(p).some(([key, value]) => value !== undefined && !filterKeys[canonical].includes(key))) add('An option is unsupported by the selected channel.');
  if (!(p.event_ids?.length || p.sport_ids?.length || p.resume)) add('Each subscription requires event or sport scope.');
  const priced = ['markets', 'futures'].includes(channel);
  if (priced && (!p.market_ids?.length || !p.affiliate_ids?.length)) add('Price subscriptions require market_ids and affiliate_ids.');
  if (channel === 'hedge' && (!p.event_ids?.length || !p.affiliate_ids?.length)) add('Hedge subscriptions require event_ids and affiliate_ids.');
  if (!priced && channel !== 'hedge' && (p.market_ids || p.affiliate_ids || p.main_line !== undefined)) add('This channel does not support market/book filters.');
  if (channel !== 'hedge' && ['sources', 'min_percent', 'include_live', 'include_links'].some((key) => p[key] !== undefined)) add('Hedge options require the hedge channel.');
  if (channel === 'hedge' && (p.sport_ids || p.market_ids || p.main_line !== undefined)) add('Hedge supports event and affiliate scope, not sport or market filters.');
  if (p.before_sequence && p.after_sequence) add('before_sequence and after_sequence are mutually exclusive.');
  if (p.resume) {
    if (channel !== 'plays' || p.snapshot || p.before_sequence || p.after_sequence) add('Only plays can resume, without snapshot or sequence pagination.');
    if (p.event_ids && [...new Set(p.event_ids)].sort().join(',') !== Object.keys(p.resume.plays).sort().join(',')) add('event_ids must exactly match resume.plays keys.');
  }
  if (p.snapshot) {
    if (channel === 'stats' || channel === 'hedge') add('This channel has no supported snapshot baseline.');
    else if (channel === 'plays' && !p.event_ids?.length) add('Play snapshots require event_ids.');
    else if (channel === 'futures') {
      if (!p.sport_ids?.length || p.date || (p.event_ids?.length && p.sport_ids.length !== 1)) add('Futures snapshots require sport_ids, no date, and one sport for event scope.');
    } else if (!p.event_ids?.length && !(p.sport_ids?.length && p.date)) add('Snapshots require event_ids or sport_ids plus date.');
  }
}

const withScope = (schema, endpoint) => schema.superRefine((args, ctx) => scopeErrors({ ...args, endpoint }, ctx));
export const liveStreamSchemas = Object.freeze({
  v1: withScope(z.strictObject({ filters: v1Filters, ...observe }), 'v1'),
  v2_markets: withScope(z.strictObject({ filters: marketFilters, ...observe }), 'v2_markets'),
  v2_hedge: withScope(z.strictObject({ filters: hedgeFilters, ...observe }), 'v2_hedge'),
  v2: withScope(z.strictObject({ subscriptions: z.array(subscription).min(1).max(3), actions: z.array(action).max(6).default([]), ...observe }), 'v2'),
});

export class LiveStreamError extends Error {
  constructor(code, status = null, retryAfter = null) {
    super('The bounded WebSocket capture could not complete.');
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function containsBlockedAffiliate(value, parent = '') {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((child) => containsBlockedAffiliate(child, parent));
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return (['affiliateid', 'sportsbookid'].includes(normalized) && Number(child) === 27)
      || (normalized === 'id' && (['affiliate', 'affiliates', 'sportsbooks'].includes(parent)
        || parent.startsWith('bestaffiliate')) && Number(child) === 27)
      || (normalized === 'affiliateids' && Array.isArray(child) && child.some((id) => Number(id) === 27))
      || (['prices', 'lines', 'lineperiods', 'affiliates', 'sportsbooks', 'affiliatesourceids',
        'affiliatedeeplinks', 'affiliatedeeplinktypes'].includes(parent) && Number(key) === 27)
      || containsBlockedAffiliate(child, normalized);
  });
}

function boundedStructure(value) {
  const queue = [[value, 0]];
  let nodes = 0;
  while (queue.length) {
    const [item, depth] = queue.pop();
    if (++nodes > 20000 || depth > 32) return false;
    if (item && typeof item === 'object') for (const child of Object.values(item)) queue.push([child, depth + 1]);
  }
  return true;
}

function redact(value, key) {
  if (typeof value === 'string') return value.split(key).join('[redacted]');
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [redact(name, key), redact(item, key)]));
  return value;
}

// Every invocation owns and closes one actual upstream socket. The injected
// constructor is a server dependency for offline tests, never a tool input.
export async function captureWebSocket({ endpoint, apiKey, args, signal, expiresAt }, { WebSocketImpl = WebSocket } = {}) {
  if (!liveStreamSchemas[endpoint]) throw new LiveStreamError('invalid_request');
  const parsed = liveStreamSchemas[endpoint].safeParse(args);
  if (!parsed.success) throw new LiveStreamError('invalid_request');
  args = parsed.data;
  if (typeof apiKey !== 'string' || !apiKey || apiKey.length > 4096 || /[\s,]/.test(apiKey)) throw new LiveStreamError('missing_credentials', 401);
  if (signal?.aborted) throw new LiveStreamError('request_aborted');
  const expiry = expiresAt === undefined || expiresAt === null ? null : (typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt));
  if (expiry !== null && (!Number.isFinite(expiry) || expiry <= Date.now())) throw new LiveStreamError('credential_expired', 401);
  const url = new URL(PATHS[endpoint], 'wss://therundown.io');
  for (const [key, value] of Object.entries(args.filters ?? {})) url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
  const started = Date.now();
  const frames = [];
  const snapshotComplete = new Set();
  const resumeComplete = Object.create(null);
  const acked = new Set();
  const requestedSnapshots = new Set((args.subscriptions ?? []).filter((sub) => sub.params.snapshot).map((sub) => sub.id));
  const pendingSnapshots = new Map([...requestedSnapshots].map((id) => [id, 1]));
  const pendingResyncs = new Map();
  const pendingUnsubscribes = new Map();
  const resyncAck = new Set();
  const requestedResumes = new Set((args.subscriptions ?? []).filter((sub) => sub.params.resume).map((sub) => sub.id));
  const gaps = new Set();
  const subSequences = new Map();
  let receivedBytes = 0, receivedFrames = 0, filteredFrames = 0, socket, stopReason, failure, controlsSent = false;
  let captureTimer, handshakeTimer, expiryTimer, closingTimer;
  const commandsSent = [];
  await new Promise((resolve, reject) => {
    const clear = () => {
      for (const timer of [captureTimer, handshakeTimer, expiryTimer, closingTimer]) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const finish = () => {
      clear();
      if (!failure && signal?.aborted) failure = new LiveStreamError('request_aborted');
      if (!failure && expiry !== null && expiry <= Date.now()) failure = new LiveStreamError('credential_expired', 401);
      failure ? reject(failure) : resolve();
    };
    const stop = (reason, error) => {
      if (stopReason) {
        if (error && !failure) { failure = error; socket?.terminate(); }
        return;
      }
      stopReason = reason;
      failure = error;
      clearTimeout(captureTimer);
      clearTimeout(handshakeTimer);
      if (!socket || socket.readyState === WebSocket.CLOSED) { finish(); return; }
      // Connecting terminate aborts the HTTP handshake; open sockets first
      // send close, then terminate if the peer fails to acknowledge promptly.
      if (socket.readyState === WebSocket.CONNECTING || error || reason === 'byte_limit' || reason === 'frame_limit') socket.terminate();
      else {
        try { socket.close(1000, 'bounded capture complete'); } catch { socket.terminate(); }
        closingTimer = setTimeout(() => socket.terminate(), CLOSE_MS);
      }
    };
    const abort = () => stop('cancelled', new LiveStreamError('request_aborted'));
    const send = (control) => {
      if (stopReason) return;
      commandsSent.push(control.action);
      const wire = { ...control };
      if (wire.params?.offset !== undefined) wire.params = { ...wire.params, offset: String(wire.params.offset) };
      socket.send(JSON.stringify(wire), (error) => { if (error) stop('upstream_error', new LiveStreamError('upstream_unavailable', 503)); });
    };
    const sendActions = () => {
      if (controlsSent || !args.subscriptions?.every((sub) => acked.has(sub.id))
        || [...requestedSnapshots].some((id) => !snapshotComplete.has(id))
        || [...requestedResumes].some((id) => !Object.hasOwn(resumeComplete, id))) return;
      controlsSent = true;
      for (const control of args.actions) {
        if (control.action === 'snapshot' || control.action === 'resync') {
          requestedSnapshots.add(control.id);
          pendingSnapshots.set(control.id, (pendingSnapshots.get(control.id) ?? 0) + 1);
          snapshotComplete.delete(control.id);
        }
        if (control.action === 'resync') pendingResyncs.set(control.id, (pendingResyncs.get(control.id) ?? 0) + 1);
        if (control.action === 'unsubscribe') pendingUnsubscribes.set(control.id, (pendingUnsubscribes.get(control.id) ?? 0) + 1);
        send(control);
      }
    };
    try {
      socket = new WebSocketImpl(url.href, { headers: { 'X-TheRundown-Key': apiKey }, followRedirects: false, handshakeTimeout: HANDSHAKE_MS, perMessageDeflate: false, maxPayload: MAX_BYTES, maxFragments: 64, maxBufferedChunks: 256 });
    } catch { failure = new LiveStreamError('upstream_unavailable', 503); finish(); return; }
    socket.on('error', (error) => stop('upstream_error', new LiveStreamError(error?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'response_too_large' : 'upstream_unavailable', 503)));
    socket.once('unexpected-response', (request, response) => {
      const status = response.statusCode;
      const retry = /^\d{1,6}$/.test(response.headers['retry-after'] ?? '') ? Number(response.headers['retry-after']) : null;
      response.destroy();
      request.destroy();
      stop('handshake_rejected', new LiveStreamError('upstream_rejected', [401, 403, 429].includes(status) ? status : 503, status === 429 ? retry : null));
    });
    socket.once('close', () => { if (!stopReason) { stopReason = 'upstream_closed'; gaps.add('upstream_closed'); } finish(); });
    socket.once('open', () => {
      if (stopReason) return;
      clearTimeout(handshakeTimer);
      if (expiry !== null && expiry <= Date.now()) { stop('credential_expired', new LiveStreamError('credential_expired', 401)); return; }
      captureTimer = setTimeout(() => stop('duration_limit'), args.duration_ms);
      for (const sub of args.subscriptions ?? []) send({ action: 'subscribe', ...sub });
    });
    socket.on('message', (raw, isBinary) => {
      if (stopReason) return;
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      receivedFrames += 1;
      receivedBytes += bytes.byteLength;
      if (receivedBytes > MAX_BYTES) { gaps.add('byte_limit'); stop('byte_limit'); return; }
      if (isBinary) { stop('invalid_frame', new LiveStreamError('invalid_response', 503)); return; }
      let frame;
      try { frame = JSON.parse(bytes.toString('utf8')); } catch { stop('invalid_frame', new LiveStreamError('invalid_response', 503)); return; }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame) || !boundedStructure(frame)) { stop('invalid_frame', new LiveStreamError('invalid_response', 503)); return; }
      if (containsBlockedAffiliate(frame)) { filteredFrames += 1; gaps.add('blocked_affiliate_filtered'); }
      else {
        try { frame = redact(publicProductData(frame), apiKey); } catch { stop('invalid_frame', new LiveStreamError('invalid_response', 503)); return; }
        frames.push(frame);
        if (frame.type === 'subscribed') acked.add(frame.id);
        if (frame.type === 'snapshot_complete' && pendingSnapshots.get(frame.id) > 0) {
          const pending = pendingSnapshots.get(frame.id) - 1;
          pendingSnapshots.set(frame.id, pending);
          if (pending === 0) snapshotComplete.add(frame.id);
        }
        if (frame.type === 'resync_ack' && pendingResyncs.get(frame.id) > 0) {
          pendingResyncs.set(frame.id, pendingResyncs.get(frame.id) - 1);
          if (pendingResyncs.get(frame.id) === 0) resyncAck.add(frame.id);
        }
        if (frame.type === 'unsubscribed' && pendingUnsubscribes.get(frame.id) > 0) pendingUnsubscribes.set(frame.id, pendingUnsubscribes.get(frame.id) - 1);
        if (frame.type === 'resume_complete' && frame.cursors && typeof frame.cursors === 'object' && !Array.isArray(frame.cursors)) resumeComplete[frame.id] = frame.cursors;
        if (frame.type === 'delta' && Number.isInteger(frame.sub_sequence)) {
          const previous = subSequences.get(frame.id);
          if ((previous !== undefined && frame.sub_sequence !== previous + 1) || (previous === undefined && frame.sub_sequence !== 1)) gaps.add(`sub_sequence_gap:${frame.id}`);
          subSequences.set(frame.id, frame.sub_sequence);
        }
        if (['error', 'snapshot_error'].includes(frame.type)) gaps.add(`upstream_${frame.type}`);
        sendActions();
      }
      if (receivedFrames >= args.max_frames) { gaps.add('frame_limit'); stop('frame_limit'); }
    });
    handshakeTimer = setTimeout(() => stop('handshake_timeout', new LiveStreamError('upstream_unavailable', 503)), HANDSHAKE_MS);
    if (expiry !== null) expiryTimer = setTimeout(() => stop('credential_expired', new LiveStreamError('credential_expired', 401)), Math.max(1, expiry - Date.now()));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  for (const sub of args.subscriptions ?? []) if (!acked.has(sub.id)) gaps.add(`subscription_not_acknowledged:${sub.id}`);
  for (const id of requestedSnapshots) if (!snapshotComplete.has(id)) gaps.add(`snapshot_incomplete:${id}`);
  for (const id of requestedResumes) if (!Object.hasOwn(resumeComplete, id)) gaps.add(`resume_incomplete:${id}`);
  for (const [id, pending] of pendingResyncs) if (pending > 0) gaps.add(`resync_incomplete:${id}`);
  for (const [id, pending] of pendingUnsubscribes) if (pending > 0) gaps.add(`unsubscribe_incomplete:${id}`);
  if (args.actions?.length && !controlsSent) gaps.add('controls_not_sent');
  return { source_url: url.href, started_at: new Date(started).toISOString(), finished_at: new Date().toISOString(), duration_ms: Date.now() - started, stop_reason: stopReason, received_frames: receivedFrames, received_bytes: receivedBytes, filtered_frames: filteredFrames, commands_sent: commandsSent, frames, snapshot_complete: [...snapshotComplete], resync_ack: [...resyncAck], resume_complete: { ...resumeComplete }, incomplete: gaps.size > 0, gaps: [...gaps], persistent_stream: false };
}
