import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createDataServer } from './server.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_CONCURRENCY = 16;
const MAX_CONCURRENCY = 64;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const CREDENTIAL_ALIASES = new Set([
  'api-key', 'api_key', 'apikey', 'x-api-key', 'x-api-token', 'x-auth-token',
  'x-rundown-key', 'x-therundown-api-key',
]);
const CORS_HEADERS = new Set([
  'authorization', 'content-type', 'mcp-protocol-version', 'x-therundown-key',
]);

function configError(message) {
  throw new Error(`Invalid hosted MCP configuration: ${message}`);
}

function positiveInteger(value, fallback, label, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === '') return fallback;
  if (!/^[1-9]\d*$/.test(String(value))) configError(`${label} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) configError(`${label} must be at most ${max}.`);
  return parsed;
}

function publicOriginPolicy(value) {
  if (!value) configError('THERUNDOWN_MCP_PUBLIC_ORIGIN is required.');
  let origin;
  try {
    origin = new URL(value);
  } catch {
    configError('THERUNDOWN_MCP_PUBLIC_ORIGIN must be an absolute origin.');
  }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    configError('THERUNDOWN_MCP_PUBLIC_ORIGIN must contain only an origin.');
  }
  const localHttp = origin.protocol === 'http:' && LOOPBACK_HOSTS.has(origin.hostname.replace(/^\[|\]$/g, ''));
  if (origin.protocol !== 'https:' && !localHttp) {
    configError('THERUNDOWN_MCP_PUBLIC_ORIGIN must use HTTPS outside loopback tests.');
  }
  return { origin: origin.origin, host: origin.host };
}

function jsonError(res, status, message, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  const data = {
    status, plan: null, missing_entitlement: null, required_plan: null,
    retry_after: headers['retry-after'] ? Number(headers['retry-after']) : null,
    remaining_points: null, monthly_remaining_points: null,
    limit_reason: status === 429 ? 'mcp_capacity' : null,
  };
  const text = JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message, data }, id: null });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function hasSingleHeader(req, name) {
  return req.rawHeaders.filter((_, index) => index % 2 === 0
    && req.rawHeaders[index].toLowerCase() === name).length === 1;
}

function hasAnyHeader(req, name) {
  return req.rawHeaders.some((_, index) => index % 2 === 0
    && req.rawHeaders[index].toLowerCase() === name);
}

function credentialFrom(req) {
  const hasKey = hasAnyHeader(req, 'x-therundown-key');
  const hasAuthorization = hasAnyHeader(req, 'authorization');
  if (req.rawHeaders.some((_, index) => index % 2 === 0
    && CREDENTIAL_ALIASES.has(req.rawHeaders[index].toLowerCase()))
    || hasKey === hasAuthorization || (hasKey && !hasSingleHeader(req, 'x-therundown-key'))
    || (hasAuthorization && !hasSingleHeader(req, 'authorization'))) return undefined;
  const raw = hasKey ? req.headers['x-therundown-key'] : req.headers.authorization;
  if (Array.isArray(raw) || typeof raw !== 'string' || !raw || /[\r\n]/.test(raw)) return undefined;
  const key = hasKey ? raw : (/^Bearer ([^\s,]+)$/.exec(raw)?.[1]);
  // Product keys are header values, never display strings. Reject surrounding
  // whitespace so one customer cannot occupy multiple semaphore identities.
  if (!key || key.trim() !== key) return undefined;
  return key;
}

function acceptsJson(req) {
  const value = req.headers['content-type'];
  if (Array.isArray(value) || typeof value !== 'string') return false;
  return value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

async function readJsonBody(req, signal) {
  const contentLength = req.headers['content-length'];
  if (typeof contentLength === 'string' && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    const error = new Error('body_too_large');
    error.code = 'body_too_large';
    throw error;
  }
  if (signal.aborted) throw Object.assign(new Error('request_aborted'), { code: 'request_aborted' });
  const chunks = [];
  let size = 0;
  await new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(Object.assign(new Error('request_aborted'), { code: 'request_aborted' }));
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        cleanup();
        req.pause();
        reject(Object.assign(new Error('body_too_large'), { code: 'body_too_large' }));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', abort);
      signal.removeEventListener('abort', abort);
    };
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', abort);
    signal.addEventListener('abort', abort, { once: true });
    req.on('data', onData);
  });
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('invalid_jsonrpc');
    }
    return body;
  } catch (error) {
    if (error?.code) throw error;
    throw Object.assign(new Error('invalid_json'), { code: 'invalid_json' });
  }
}

function isAllowedRequest(req, policy) {
  let url;
  try {
    url = new URL(req.url, policy.origin);
  } catch {
    return false;
  }
  return req.url.startsWith('/') && !req.url.startsWith('//')
    && hasSingleHeader(req, 'host') && req.headers.host === policy.host
    && (url.pathname === '/' || url.pathname === '/mcp') && url.search === ''
    && !req.url.includes('?');
}

function addCorsHeaders(res, origin, policy) {
  if (!origin) return;
  if (origin !== policy.origin) return false;
  res.setHeader('access-control-allow-origin', policy.origin);
  res.setHeader('access-control-allow-headers', 'Authorization, Content-Type, Mcp-Protocol-Version, X-TheRundown-Key');
  res.setHeader('access-control-allow-methods', 'POST');
  res.setHeader('vary', 'Origin');
  return true;
}

function isValidPreflight(req) {
  if (!hasSingleHeader(req, 'access-control-request-method')
    || req.headers['access-control-request-method'] !== 'POST') return false;
  if (!hasSingleHeader(req, 'access-control-request-headers')) return false;
  const requested = req.headers['access-control-request-headers'];
  if (typeof requested !== 'string') return false;
  const names = requested.split(',').map((name) => name.trim().toLowerCase());
  return names.length > 0 && names.every((name) => name && CORS_HEADERS.has(name))
    && new Set(names).size === names.length;
}

function abortableResponse(response, signal) {
  if (!response?.body) return { response, bodyDone: Promise.resolve() };
  const reader = response.body.getReader();
  let finish;
  const bodyDone = new Promise((resolve) => { finish = resolve; });
  let finished = false;
  let aborting = false;
  const close = () => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', abort);
    finish();
  };
  const abort = () => {
    // Cancel the original reader, including after the wrapper is locked by the
    // JSON parser. This stops native response bodies instead of merely ending
    // a local wrapper stream.
    aborting = true;
    reader.cancel().catch(() => {}).finally(close);
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          if (!aborting) close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        if (!aborting) close();
      }
    },
    cancel() {
      aborting = true;
      return reader.cancel().catch(() => {}).finally(close);
    },
  });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    bodyDone,
  };
}

/**
 * Make the future Streamable HTTP adapter. It is intentionally not started by
 * import, and does not assert that any public hostname is currently deployed.
 */
export function createHostedServer({
  publicOrigin = process.env.THERUNDOWN_MCP_PUBLIC_ORIGIN,
  fetchImpl = fetch,
  maxConcurrent = process.env.THERUNDOWN_MCP_MAX_CONCURRENT,
  requestTimeoutMs = process.env.THERUNDOWN_MCP_REQUEST_TIMEOUT_MS,
} = {}) {
  const policy = publicOriginPolicy(publicOrigin);
  const concurrencyCap = positiveInteger(maxConcurrent, DEFAULT_CONCURRENCY, 'THERUNDOWN_MCP_MAX_CONCURRENT', MAX_CONCURRENCY);
  const timeoutMs = positiveInteger(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'THERUNDOWN_MCP_REQUEST_TIMEOUT_MS', 60_000);
  if (typeof fetchImpl !== 'function') configError('fetchImpl must be a function.');

  let activeTotal = 0;
  const activeByKey = new Map();

  const httpServer = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (hasAnyHeader(req, 'origin') && (!hasSingleHeader(req, 'origin')
      || typeof origin !== 'string' || !addCorsHeaders(res, origin, policy))) {
      jsonError(res, 403, 'Request origin is not allowed.');
      return;
    }
    if (!isAllowedRequest(req, policy)) {
      jsonError(res, 403, 'Request host or path is not allowed.');
      return;
    }
    if (req.method === 'OPTIONS') {
      if (!origin || !isValidPreflight(req)) {
        jsonError(res, 403, 'CORS preflight is not allowed.');
      } else {
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
      }
      return;
    }
    if (req.method !== 'POST') {
      jsonError(res, 405, 'Only POST is supported.', { allow: 'POST' });
      return;
    }
    if (!acceptsJson(req)) {
      jsonError(res, 415, 'Content-Type must be application/json.');
      return;
    }
    const apiKey = credentialFrom(req);
    if (!apiKey) {
      jsonError(res, 401, 'Send a Product API key in exactly one header: X-TheRundown-Key or Authorization: Bearer.');
      return;
    }
    // The active map is bounded by the process cap and contains only digests.
    const keyDigest = createHash('sha256').update(apiKey).digest('base64url');
    if (activeTotal >= concurrencyCap || activeByKey.has(keyDigest)) {
      jsonError(res, 429, 'Request capacity is busy. Retry after one second.', { 'retry-after': '1' });
      return;
    }
    activeTotal += 1;
    activeByKey.set(keyDigest, true);

    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    const pendingFetches = new Set();
    const trackedFetch = (url, init = {}) => {
      const request = Promise.resolve().then(async () => {
        const upstream = await fetchImpl(url, {
          ...init,
          signal: AbortSignal.any([controller.signal, ...(init.signal ? [init.signal] : [])]),
        });
        const wrapped = abortableResponse(upstream, controller.signal);
        pendingFetches.add(wrapped.bodyDone);
        wrapped.bodyDone.finally(() => pendingFetches.delete(wrapped.bodyDone)).catch(() => {});
        return wrapped.response;
      });
      pendingFetches.add(request);
      request.finally(() => pendingFetches.delete(request)).catch(() => {});
      return request;
    };
    // `aborted` catches a client that stops while sending a body. `close` only
    // aborts a response that has not finished, so normal JSON response cleanup
    // does not cancel a completed call.
    req.once('aborted', abort);
    res.once('close', () => {
      if (!res.writableEnded) abort();
    });

    try {
      const body = await readJsonBody(req, controller.signal);
      if (controller.signal.aborted) throw Object.assign(new Error('request_aborted'), { code: 'request_aborted' });
      const server = createDataServer({ apiKey, fetchImpl: trackedFetch });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: [policy.host],
        allowedOrigins: [policy.origin],
      });
      try {
        // Hono's Node bridge preserves this pre-set header when it writes the
        // transport's JSON response. Error responses set it independently.
        res.setHeader('cache-control', 'no-store');
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } finally {
        await Promise.allSettled([...pendingFetches]);
        await Promise.allSettled([transport.close(), server.close()]);
      }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const status = error?.code === 'body_too_large' ? 413
          : error?.code === 'invalid_json' || error?.code === 'invalid_jsonrpc' ? 400
          : controller.signal.aborted ? 408 : 500;
        const message = status === 413 ? 'Request body exceeds 64 KiB.'
          : status === 400 ? 'Request must contain one JSON-RPC object.'
          : status === 408 ? 'Request timed out or was cancelled.'
          : 'Unable to process the request.';
        jsonError(res, status, message);
      }
    } finally {
      clearTimeout(timer);
      req.off('aborted', abort);
      activeByKey.delete(keyDigest);
      activeTotal -= 1;
    }
  });
  httpServer.maxConnections = concurrencyCap * 8;
  httpServer.headersTimeout = Math.min(timeoutMs, 10_000);
  httpServer.requestTimeout = timeoutMs;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.maxRequestsPerSocket = 100;
  return httpServer;
}

export async function listenHostedServer(options = {}) {
  const server = createHostedServer(options);
  const bindHost = options.bindHost ?? process.env.THERUNDOWN_MCP_BIND_HOST ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(bindHost)) configError('THERUNDOWN_MCP_BIND_HOST must be loopback.');
  const port = positiveInteger(options.port ?? process.env.THERUNDOWN_MCP_PORT, 3000, 'THERUNDOWN_MCP_PORT', 65535);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindHost, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await listenHostedServer();
    process.stderr.write('TheRundown hosted MCP adapter is listening on loopback. Public rollout is operator-managed.\n');
  } catch {
    process.stderr.write('Unable to start the hosted MCP adapter. Check loopback bind and public-origin configuration.\n');
    process.exitCode = 1;
  }
}
