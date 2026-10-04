import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createDataServer } from './server.mjs';
import { exchangeOAuthCredential, OAuthExchangeError, OAUTH_METADATA, OAUTH_METADATA_PATH, OAUTH_RESOURCE, OAUTH_SCOPE } from './oauth.mjs';

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

function jsonError(res, status, message, headers = {}, details = {}) {
  if (res.headersSent || res.destroyed) return;
  const data = {
    status, plan: null, missing_entitlement: null, required_plan: null,
    retry_after: headers['retry-after'] ? Number(headers['retry-after']) : null,
    remaining_points: null, monthly_remaining_points: null,
    limit_reason: status === 429 ? 'mcp_capacity' : null,
    ...details,
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

// MCP tool errors must carry the OAuth challenge inside the result for ChatGPT
// to offer account linking. This is an error envelope, never anonymous data.
function oauthToolError(res, body, challenge, message) {
  if (body?.jsonrpc !== '2.0' || body.method !== 'tools/call'
    || !(typeof body.id === 'string' || (typeof body.id === 'number' && Number.isFinite(body.id)))
    || !body.params || typeof body.params.name !== 'string') return false;
  const text = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
    isError: true,
    content: [{ type: 'text', text: message }],
    _meta: { 'mcp/www_authenticate': [challenge] },
  } });
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text), 'www-authenticate': challenge,
  });
  res.end(text);
  return true;
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
  // Product keys are single header values. Reject whitespace and comma lists
  // so clients and proxies cannot interpret the credential differently.
  if (!key || /[\s,]/.test(key)) return undefined;
  return key;
}

function hasCredentialInput(req) {
  return hasAnyHeader(req, 'x-therundown-key') || hasAnyHeader(req, 'authorization')
    || req.rawHeaders.some((_, index) => index % 2 === 0
      && CREDENTIAL_ALIASES.has(req.rawHeaders[index].toLowerCase()));
}

function oauthTokenFrom(req) {
  if (hasAnyHeader(req, 'x-therundown-key') || !hasSingleHeader(req, 'authorization')
    || req.rawHeaders.some((_, index) => index % 2 === 0
      && CREDENTIAL_ALIASES.has(req.rawHeaders[index].toLowerCase()))) return undefined;
  const raw = req.headers.authorization;
  if (typeof raw !== 'string' || raw.length > 8192) return undefined;
  return /^Bearer ([^\s,]+)$/.exec(raw)?.[1];
}

// Metadata discovery is deliberately narrow: it can tell a client what this
// server is and how to use it, but can never reach the Product API. Every
// other JSON-RPC method still needs the route's credential at the HTTP boundary.
function isAnonymousDiscoveryRequest(body) {
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') return false;
  if (body.method === 'initialize' || body.method === 'notifications/initialized'
    || body.method === 'tools/list' || body.method === 'resources/list' || body.method === 'ping') return true;
  return body.method === 'resources/read'
    && body.params && typeof body.params === 'object' && !Array.isArray(body.params)
    && body.params.uri === 'therundown://brief';
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
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid_json'), { code: 'invalid_json' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('invalid_jsonrpc'), { code: 'invalid_jsonrpc' });
  }
  return body;
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
    && ['/', '/mcp', '/oauth/mcp', OAUTH_METADATA_PATH].includes(req.url) && url.search === ''
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
 * Make the Streamable HTTP adapter. It is intentionally not started by
 * import, and does not assert that any public hostname is currently deployed.
 */
export function createHostedServer({
  publicOrigin = process.env.THERUNDOWN_MCP_PUBLIC_ORIGIN,
  fetchImpl = fetch,
  maxConcurrent = process.env.THERUNDOWN_MCP_MAX_CONCURRENT,
  requestTimeoutMs = process.env.THERUNDOWN_MCP_REQUEST_TIMEOUT_MS,
  exchangeSecret = process.env.THERUNDOWN_MCP_EXCHANGE_SECRET,
  WebSocketImpl,
} = {}) {
  const policy = publicOriginPolicy(publicOrigin);
  const concurrencyCap = positiveInteger(maxConcurrent, DEFAULT_CONCURRENCY, 'THERUNDOWN_MCP_MAX_CONCURRENT', MAX_CONCURRENCY);
  const timeoutMs = positiveInteger(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'THERUNDOWN_MCP_REQUEST_TIMEOUT_MS', 60_000);
  if (typeof fetchImpl !== 'function') configError('fetchImpl must be a function.');
  if (exchangeSecret !== undefined && (typeof exchangeSecret !== 'string'
    || !exchangeSecret || exchangeSecret.length > 4096 || /[\s,]/.test(exchangeSecret))) {
    configError('THERUNDOWN_MCP_EXCHANGE_SECRET must be a single secret header value.');
  }
  if (exchangeSecret && policy.origin !== new URL(OAUTH_RESOURCE).origin
    && !LOOPBACK_HOSTS.has(new URL(policy.origin).hostname.replace(/^\[|\]$/g, ''))) {
    configError('OAuth requires the registered mcp.therundown.io resource origin.');
  }
  const oauthChallenge = { 'www-authenticate': `Bearer resource_metadata="${policy.origin}${OAUTH_METADATA_PATH}", scope="${OAUTH_SCOPE}"` };
  const linkingChallenge = `${oauthChallenge['www-authenticate']}, error="invalid_token", error_description="Connect or reconnect your TheRundown account to continue"`;

  let activeTotal = 0;
  const activeByKey = new Map();
  const activeByAccount = new Set();

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
    const isOAuth = req.url === '/oauth/mcp';
    if (req.url === OAUTH_METADATA_PATH) {
      if (!exchangeSecret) {
        jsonError(res, 404, 'OAuth account linking is unavailable.');
      } else if (req.method !== 'GET') {
        jsonError(res, 405, 'Only GET is supported.', { allow: 'GET' });
      } else {
        const body = JSON.stringify(OAUTH_METADATA);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
      }
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
    if (isOAuth && !exchangeSecret) {
      jsonError(res, 503, 'OAuth account linking is unavailable.');
      return;
    }
    const credential = isOAuth ? oauthTokenFrom(req) : credentialFrom(req);
    if (!credential && hasCredentialInput(req)) {
      jsonError(res, 401, isOAuth ? 'Send one OAuth access token in Authorization: Bearer.'
        : 'Send a Product API key in exactly one header: X-TheRundown-Key or Authorization: Bearer.', isOAuth ? oauthChallenge : {});
      return;
    }
    // Admission happens before reading a body, including for the one shared
    // anonymous identity. Slow uploads cannot bypass the existing process cap.
    // The map contains only namespaced digests, never customer credentials.
    const keyDigest = createHash('sha256')
      .update(JSON.stringify([credential ? (isOAuth ? 'oauth' : 'authenticated') : 'anonymous', credential ?? '']))
      .digest('base64url');
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
    let accountDigest;
    let body;
    const trackedFetch = (url, init = {}) => {
      const request = Promise.resolve().then(async () => {
        const signal = AbortSignal.any([controller.signal, ...(init.signal ? [init.signal] : [])]);
        const upstream = await fetchImpl(url, {
          ...init,
          signal,
        });
        const wrapped = abortableResponse(upstream, signal);
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
      body = await readJsonBody(req, controller.signal);
      if (controller.signal.aborted) throw Object.assign(new Error('request_aborted'), { code: 'request_aborted' });
      // OAuth initialization must challenge before protocol negotiation;
      // authenticated initialization uses the same fresh exchange as tool calls.
      const discovery = isAnonymousDiscoveryRequest(body)
        && !(isOAuth && body.method === 'initialize');
      if (!credential && !discovery) {
        if (isOAuth && oauthToolError(res, body, linkingChallenge,
          'Connect a TheRundown account with OAuth before calling this tool.')) return;
        jsonError(res, 401, isOAuth ? 'Connect a TheRundown account with OAuth before calling this method.'
          : 'Send a Product API key in exactly one header: X-TheRundown-Key or Authorization: Bearer.', isOAuth ? oauthChallenge : {});
        return;
      }
      let apiKey = isOAuth ? null : credential;
      let expiresAt;
      if (isOAuth && !discovery) {
        const resolved = await exchangeOAuthCredential(credential, exchangeSecret, trackedFetch, controller.signal);
        if (controller.signal.aborted) throw Object.assign(new Error('request_aborted'), { code: 'request_aborted' });
        const digest = createHash('sha256').update(resolved.accountId).digest('base64url');
        if (activeByAccount.has(digest)) {
          jsonError(res, 429, 'Request capacity is busy. Retry after one second.', { 'retry-after': '1' });
          return;
        }
        accountDigest = digest;
        activeByAccount.add(accountDigest);
        apiKey = resolved.apiKey;
        expiresAt = resolved.expiresAt;
      }
      const server = createDataServer({ apiKey: apiKey ?? null, fetchImpl: trackedFetch, oauthSecurity: isOAuth,
        signal: controller.signal, expiresAt, WebSocketImpl, oauthChallenge: linkingChallenge });
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
        const status = controller.signal.aborted ? 408
          : error instanceof OAuthExchangeError ? error.status
          : error?.code === 'body_too_large' ? 413
          : error?.code === 'invalid_json' || error?.code === 'invalid_jsonrpc' ? 400
          : 500;
        const message = error instanceof OAuthExchangeError && status !== 408
          ? ({ 401: 'OAuth access was rejected. Reconnect your TheRundown account.',
            403: 'The connected account does not have active Product API access.',
            429: 'Account access is rate limited. Do not automatically retry.',
            503: 'OAuth account access is temporarily unavailable.' }[status])
          : status === 413 ? 'Request body exceeds 64 KiB.'
          : error?.code === 'invalid_json' ? 'Request body must contain valid JSON.'
          : status === 400 ? 'Request must contain one JSON-RPC object.'
          : status === 408 ? 'Request timed out or was cancelled.'
          : 'Unable to process the request.';
        const headers = isOAuth && status === 401 ? oauthChallenge
          : error instanceof OAuthExchangeError && error.retryAfter !== null
            ? { 'retry-after': String(error.retryAfter) } : {};
        if (isOAuth && status === 401 && oauthToolError(res, body, linkingChallenge, message)) return;
        jsonError(res, status, message, headers,
          error instanceof OAuthExchangeError ? { limit_reason: null } : {});
      }
    } finally {
      await Promise.allSettled([...pendingFetches]);
      clearTimeout(timer);
      req.off('aborted', abort);
      activeByKey.delete(keyDigest);
      if (accountDigest) activeByAccount.delete(accountDigest);
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
