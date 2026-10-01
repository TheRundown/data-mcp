import assert from 'node:assert/strict';
import { createServer as createNetServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHostedServer } from '../hosted.mjs';
import { OAUTH_RESOURCE, OAUTH_EXCHANGE_URL, OAUTH_METADATA_PATH, OAUTH_ISSUER } from '../oauth.mjs';

const KEY_A = 'synthetic-tenant-alpha';
const KEY_B = 'synthetic-tenant-bravo';
const REQUEST = {
  jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'hosted-test', version: '1.0.0' },
  },
};

function response(body) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

async function freePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function hosted(fetchImpl, { allocatePort = freePort, ...options } = {}) {
  // The policy needs the concrete origin before listen. Another test process
  // can claim a released ephemeral port, so retry that one transient failure.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await allocatePort();
    const origin = `http://127.0.0.1:${port}`;
    const server = createHostedServer({ publicOrigin: origin, fetchImpl, ...options });
    try {
      server.listen(port, '127.0.0.1');
      await once(server, 'listening');
      return {
        origin,
        server,
        async close() { await new Promise((resolve) => server.close(resolve)); },
      };
    } catch (error) {
      server.close(() => {});
      if (error.code !== 'EADDRINUSE' || attempt === 4) throw error;
    }
  }
}

async function post(origin, { key = KEY_A, authorization, path = '/mcp', body = REQUEST, headers = {} } = {}) {
  const credential = authorization === undefined ? { 'X-TheRundown-Key': key } : { Authorization: authorization };
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...credential, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function postAnonymous(origin, { path = '/mcp', body = REQUEST, headers = {} } = {}) {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function rawPost(origin, headers, body = REQUEST) {
  return rawRequest(origin, { headers, body }).then(({ status }) => status);
}

async function rawRequest(origin, { method = 'POST', headers = {}, body, path = '/mcp' } = {}) {
  const endpoint = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: endpoint.hostname, port: endpoint.port, method, path, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => resolve({
        status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)));
  });
}

function unfinishedRequest(origin, key) {
  let complete;
  const finished = new Promise((resolve) => { complete = resolve; });
  const req = httpRequest(`${origin}/mcp`, {
    method: 'POST', headers: {
      accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      'content-length': 4096,
      ...(key === undefined ? {} : { 'X-TheRundown-Key': key }),
    },
  }, (res) => {
    res.resume();
    res.once('end', () => complete(res.statusCode));
  });
  req.on('error', () => complete(null));
  req.write('{"jsonrpc":');
  return { req, finished };
}

async function clientFor(origin, key) {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { 'X-TheRundown-Key': key } },
  });
  const client = new Client({ name: 'hosted-integration-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

async function anonymousClientFor(origin) {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`));
  const client = new Client({ name: 'anonymous-hosted-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

async function closeClient(connection) {
  await Promise.allSettled([connection.client.close(), connection.transport.close()]);
}

function callSports() {
  return {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_sports', arguments: {} },
  };
}

test('configuration keeps production origins, process capacity, and request deadlines bounded', () => {
  for (const publicOrigin of ['http://example.com', 'https://example.com/path', 'https://example.com?key=placeholder']) {
    assert.throws(() => createHostedServer({ publicOrigin }), /Invalid hosted MCP configuration/);
  }
  assert.throws(() => createHostedServer({ publicOrigin: 'https://mcp.example.com', maxConcurrent: 65 }), /at most 64/);
  assert.throws(() => createHostedServer({ publicOrigin: 'https://mcp.example.com', requestTimeoutMs: 60_001 }), /at most 60000/);
});

test('test listener retries a port claimed between allocation and binding', async () => {
  const occupied = createNetServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  let attempts = 0;
  let service;
  try {
    service = await hosted(async () => response({ sports: [] }), {
      allocatePort: () => ++attempts === 1 ? occupied.address().port : freePort(),
    });
    assert.equal(attempts, 2);
    assert.equal((await post(service.origin)).status, 200);
  } finally {
    await service?.close();
    await new Promise((resolve) => occupied.close(resolve));
  }
});

test('actual Streamable HTTP client inherits exactly six tools and the brief resource without echoing its credential', async () => {
  const service = await hosted(async (_url, options) => response({
    sports: [{ sport_id: 3, sport_name: `upstream-${options.headers['X-TheRundown-Key']}` }],
  }));
  try {
    const connection = await clientFor(service.origin, KEY_A);
    try {
      const listed = await connection.client.listTools();
      assert.deepEqual(listed.tools.map(({ name }) => name), [
        'list_sports', 'list_affiliates', 'list_markets', 'list_events', 'get_main_lines', 'list_futures',
      ]);
      const resources = await connection.client.listResources();
      assert.equal(resources.resources.some((item) => item.uri === 'therundown://brief'), true);
      const result = await connection.client.callTool({ name: 'list_sports', arguments: {} });
      const text = result.content.find((item) => item.type === 'text').text;
      assert.equal(text.includes(KEY_A), false);
      assert.equal(text.includes('[REDACTED]'), true);
    } finally {
      await closeClient(connection);
    }
    const initialized = await post(service.origin);
    assert.equal(initialized.headers.get('cache-control'), 'no-store');
  } finally {
    await service.close();
  }
});

test('anonymous discovery permits only public metadata and never calls the Product API', async () => {
  let reads = 0;
  const service = await hosted(async () => {
    reads += 1;
    return response({ sports: [] });
  });
  const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
  const resourcesList = { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} };
  const briefRead = { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'therundown://brief' } };
  try {
    for (const body of [REQUEST, toolsList, resourcesList, briefRead, {
      jsonrpc: '2.0', method: 'notifications/initialized', params: {},
    }]) {
      const result = await postAnonymous(service.origin, { body });
      assert.ok([200, 202].includes(result.status), `expected metadata request to succeed, got ${result.status}`);
    }
    const connection = await anonymousClientFor(service.origin);
    try {
      assert.deepEqual(connection.client.getServerVersion(), { name: 'therundown-data', version: '0.3.0' });
      assert.equal((await connection.client.listTools()).tools.length, 6);
      assert.equal((await connection.client.listResources()).resources[0].uri, 'therundown://brief');
      assert.equal((await connection.client.readResource({ uri: 'therundown://brief' })).contents[0].mimeType, 'text/markdown');
    } finally {
      await closeClient(connection);
    }
    assert.equal((await postAnonymous(service.origin, { body: callSports() })).status, 401);
    assert.equal((await postAnonymous(service.origin, {
      body: { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'therundown://other' } },
    })).status, 401);
    assert.equal((await postAnonymous(service.origin, {
      body: { jsonrpc: '2.0', id: 6, method: 'ping', params: {} },
    })).status, 401);
    assert.equal((await postAnonymous(service.origin, {
      body: REQUEST, headers: { Authorization: 'Basic synthetic' },
    })).status, 401);
    assert.equal(reads, 0);
  } finally {
    await service.close();
  }
});

test('accepts either supported credential form and keeps upstream tenant credentials separate', async () => {
  const received = [];
  const service = await hosted(async (_url, options) => {
    received.push(options.headers['X-TheRundown-Key']);
    return response({ sports: [] });
  });
  try {
    const protocol = { 'mcp-protocol-version': '2025-11-25' };
    assert.equal((await post(service.origin, { path: '/', body: callSports(), headers: protocol })).status, 200);
    assert.equal((await post(service.origin, {
      key: undefined, authorization: `Bearer ${KEY_B}`, body: callSports(), headers: protocol,
    })).status, 200);
    assert.deepEqual(received, [KEY_A, KEY_B]);
  } finally {
    await service.close();
  }
});

test('rejects malformed, duplicated, ambiguous, and query-string credentials on protected requests', async () => {
  let reads = 0;
  const service = await hosted(async () => { reads += 1; return response({ sports: [] }); });
  try {
    assert.equal((await post(service.origin, {
      key: undefined, authorization: 'Basic synthetic', body: callSports(),
    })).status, 401);
    const ambiguous = await post(service.origin, {
      headers: { Authorization: `Bearer ${KEY_B}` }, body: callSports(),
    });
    assert.equal(ambiguous.status, 401);
    for (const key of [`${KEY_A},${KEY_B}`, `${KEY_A}, ${KEY_B}`, `${KEY_A} ${KEY_B}`]) {
      const rejected = await post(service.origin, { key, body: callSports() });
      assert.equal(rejected.status, 401);
      const text = await rejected.text();
      assert.equal(text.includes(KEY_A), false);
      assert.equal(text.includes(KEY_B), false);
    }
    assert.equal((await post(service.origin, { path: `/mcp?key=${KEY_A}` })).status, 403);

    const duplicate = await rawPost(service.origin, {
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
      'X-TheRundown-Key': [KEY_A, KEY_A],
    });
    assert.equal(duplicate, 401);
    assert.equal(await rawPost(service.origin, {
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY_A}`, 'X-API-Key': KEY_B,
    }), 401);
    assert.equal(reads, 0);
  } finally {
    await service.close();
  }
});

test('validates host and origin and rejects unsupported method, content type, batches, and bodies over 64 KiB', async () => {
  const service = await hosted(async () => response({ sports: [] }));
  try {
    assert.equal(await rawPost(service.origin, {
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
      'X-TheRundown-Key': KEY_A, Origin: 'https://not-the-public-origin.example',
    }), 403);
    assert.equal((await rawRequest(service.origin, {
      headers: {
        Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
        'X-TheRundown-Key': KEY_A,
      },
      path: 'http://untrusted.example/mcp',
    })).status, 403);
    assert.equal(await rawPost(service.origin, {
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
      'X-TheRundown-Key': KEY_A, Host: 'wrong.example',
    }), 403);
    assert.equal((await fetch(`${service.origin}/mcp`, { headers: { 'X-TheRundown-Key': KEY_A } })).status, 405);
    assert.equal((await fetch(`${service.origin}/mcp`, {
      method: 'POST', headers: { 'X-TheRundown-Key': KEY_A, 'content-type': 'text/plain' }, body: '{}',
    })).status, 415);
    const malformed = await post(service.origin, { body: '{"jsonrpc":' });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.message, 'Request body must contain valid JSON.');
    for (const body of [[REQUEST], null, '42']) {
      const invalidObject = await post(service.origin, { body });
      assert.equal(invalidObject.status, 400);
      assert.equal((await invalidObject.json()).error.message, 'Request must contain one JSON-RPC object.');
    }
    const base = JSON.stringify(REQUEST);
    const exactLimit = `${base}${' '.repeat((64 * 1024) - Buffer.byteLength(base))}`;
    assert.equal(Buffer.byteLength(exactLimit), 64 * 1024);
    assert.equal((await post(service.origin, { body: exactLimit })).status, 200);
    assert.equal((await post(service.origin, { body: JSON.stringify({ pad: 'x'.repeat(64 * 1024) }) })).status, 413);
  } finally {
    await service.close();
  }
});

test('CORS preflight accepts only the configured origin, POST, and known MCP credential headers', async () => {
  const service = await hosted(async () => response({ sports: [] }));
  try {
    const valid = await rawRequest(service.origin, {
      method: 'OPTIONS', body: undefined,
      headers: {
        Origin: service.origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type, mcp-protocol-version, x-therundown-key',
      },
    });
    assert.equal(valid.status, 204);
    assert.equal(valid.headers['access-control-allow-origin'], service.origin);
    assert.match(valid.headers['access-control-allow-headers'], /Mcp-Protocol-Version/);
    assert.equal(valid.headers['cache-control'], 'no-store');
    assert.equal((await rawRequest(service.origin, {
      method: 'OPTIONS', body: undefined,
      headers: {
        Origin: service.origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-unapproved-header',
      },
    })).status, 403);
    assert.equal((await rawRequest(service.origin, {
      method: 'OPTIONS', body: undefined,
      headers: {
        Origin: 'https://untrusted.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization',
      },
    })).status, 403);
    assert.equal((await rawRequest(service.origin, {
      method: 'OPTIONS', body: undefined,
      headers: {
        Origin: service.origin,
        'Access-Control-Request-Method': 'DELETE',
        'Access-Control-Request-Headers': 'authorization',
      },
    })).status, 403);
  } finally {
    await service.close();
  }
});

test('same-key concurrent requests return 429 while a different key remains isolated', async () => {
  let release;
  const started = new Promise((resolve) => { release = resolve; });
  let complete;
  const hold = new Promise((resolve) => { complete = resolve; });
  const service = await hosted(async (_url, options) => {
    if (options.headers['X-TheRundown-Key'] === KEY_A) {
      release();
      await hold;
    }
    return response({ sports: [] });
  }, { maxConcurrent: 2 });
  try {
    const first = post(service.origin, { body: callSports() });
    await started;
    const busy = await post(service.origin, { body: callSports() });
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get('retry-after'), '1');
    const busyBody = await busy.json();
    assert.equal(busyBody.error.data.limit_reason, 'mcp_capacity');
    assert.equal(busyBody.error.data.retry_after, 1);
    assert.equal(busyBody.error.data.remaining_points, null);
    assert.equal(busyBody.error.data.plan, null);
    assert.equal((await post(service.origin, { key: KEY_B, body: callSports() })).status, 200);
    complete();
    assert.equal((await first).status, 200);
  } finally {
    await service.close();
  }
});

test('process-wide concurrent requests return 429 without queueing at the configured cap', async () => {
  let release;
  const started = new Promise((resolve) => { release = resolve; });
  let complete;
  const hold = new Promise((resolve) => { complete = resolve; });
  const service = await hosted(async () => {
    release();
    await hold;
    return response({ sports: [] });
  }, { maxConcurrent: 1 });
  try {
    const first = post(service.origin, { body: callSports() });
    await started;
    assert.equal((await post(service.origin, { key: KEY_B, body: callSports() })).status, 429);
    complete();
    assert.equal((await first).status, 200);
  } finally {
    await service.close();
  }
});

test('unfinished authenticated and anonymous bodies hold capacity until cancellation', async () => {
  let reads = 0;
  const service = await hosted(async () => { reads += 1; return response({ sports: [] }); }, {
    maxConcurrent: 1, requestTimeoutMs: 2_000,
  });
  try {
    for (const key of [KEY_A, undefined]) {
      const stalled = unfinishedRequest(service.origin, key);
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal((await post(service.origin, { key: KEY_B })).status, 429);
        assert.equal((await postAnonymous(service.origin)).status, 429);
      } finally {
        stalled.req.destroy();
      }
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const result = await postAnonymous(service.origin);
        if (result.status === 200) { ready = true; break; }
        assert.equal(result.status, 429);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(ready, true, 'cancelled body did not release capacity');
    }
    assert.equal(reads, 0);
  } finally {
    await service.close();
  }
});

test('anonymous unfinished bodies share the request deadline without calling the Product API', async () => {
  let reads = 0;
  const service = await hosted(async () => { reads += 1; return response({ sports: [] }); }, {
    requestTimeoutMs: 100,
  });
  const stalled = unfinishedRequest(service.origin);
  try {
    const status = await Promise.race([
      stalled.finished,
      new Promise((_, reject) => setTimeout(() => reject(new Error('body deadline exceeded')), 2_000)),
    ]);
    assert.equal(status, 408);
    assert.equal((await postAnonymous(service.origin)).status, 200);
    assert.equal(reads, 0);
  } finally {
    stalled.req.destroy();
    await service.close();
  }
});

test('client cancellation aborts upstream work and does not release the key until abort settles', async () => {
  let began;
  const upstreamBegan = new Promise((resolve) => { began = resolve; });
  let aborted;
  const upstreamAborted = new Promise((resolve) => { aborted = resolve; });
  let calls = 0;
  const service = await hosted((_url, options) => {
    calls += 1;
    if (calls > 1) return Promise.resolve(response({ sports: [] }));
    return new Promise((_resolve, reject) => {
      began();
      options.signal.addEventListener('abort', () => {
        aborted();
        setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 25);
      }, { once: true });
    });
  }, { requestTimeoutMs: 2_000 });
  try {
    const cancelled = httpRequest(`${service.origin}/mcp`, {
      method: 'POST', headers: {
        accept: 'application/json, text/event-stream', 'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25', 'X-TheRundown-Key': KEY_A,
      },
    });
    cancelled.on('error', () => {});
    cancelled.end(JSON.stringify(callSports()));
    await upstreamBegan;
    cancelled.destroy();
    await upstreamAborted;
    // The rejection is intentionally delayed. The semaphore must remain held
    // until the aborted upstream fetch settles, rather than freeing on socket close.
    assert.equal((await post(service.origin, { body: callSports() })).status, 429);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal((await post(service.origin, { body: callSports() })).status, 200);
  } finally {
    await service.close();
  }
});

test('slow body upload and upstream work share one total request deadline', { timeout: 2_000 }, async () => {
  let began;
  const upstreamBegan = new Promise((resolve) => { began = resolve; });
  let aborted;
  const upstreamAborted = new Promise((resolve) => { aborted = resolve; });
  const service = await hosted((_url, options) => new Promise((_resolve, reject) => {
    began();
    options.signal.addEventListener('abort', () => {
      aborted();
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  }), { requestTimeoutMs: 500 });
  const body = JSON.stringify(callSports());
  const started = performance.now();
  const request = httpRequest(`${service.origin}/mcp`, {
    method: 'POST', headers: {
      accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'mcp-protocol-version': '2025-11-25', 'X-TheRundown-Key': KEY_A,
    },
  }, (res) => res.resume());
  request.on('error', () => {});
  request.write(body.slice(0, 1));
  const upload = setTimeout(() => request.end(body.slice(1)), 350);
  try {
    await upstreamBegan;
    await Promise.race([
      upstreamAborted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('total request deadline exceeded')), 750)),
    ]);
    assert.ok(performance.now() - started < 750, 'body upload must not grant a second full upstream deadline');
  } finally {
    clearTimeout(upload);
    request.destroy();
    await service.close();
  }
});

test('timeout cancels an open upstream response body and holds the key until cancellation settles', async () => {
  let bodyStarted;
  const started = new Promise((resolve) => { bodyStarted = resolve; });
  let bodyCancelled;
  const cancelled = new Promise((resolve) => { bodyCancelled = resolve; });
  let calls = 0;
  const service = await hosted(() => {
    calls += 1;
    if (calls > 1) return Promise.resolve(response({ sports: [] }));
    let sent = false;
    return Promise.resolve(new Response(new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode('{"sports":'));
          bodyStarted();
          return;
        }
        return new Promise(() => {});
      },
      cancel() {
        bodyCancelled();
        return new Promise((resolve) => setTimeout(resolve, 30));
      },
    }), { headers: { 'content-type': 'application/json' } }));
  }, { requestTimeoutMs: 20 });
  try {
    const first = post(service.origin, { body: callSports() });
    await started;
    await cancelled;
    assert.equal((await post(service.origin, { body: callSports() })).status, 429);
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal((await first).status, 200);
    assert.equal((await post(service.origin, { body: callSports() })).status, 200);
  } finally {
    await service.close();
  }
});

const OAUTH_TOKEN_A = 'synthetic-oauth-alpha';
const OAUTH_TOKEN_B = 'synthetic-oauth-bravo';
const EXCHANGE_SECRET = 'synthetic-service-secret';
// Citizen wraps the complete Django signed blob (including its colon
// separators) in base64url; Product verifies the resulting signature.
const DELEGATED_KEY = `mcp1.${Buffer.from('{"scope":"mcp:read"}:1wABC:offline-signature').toString('base64url')}`;
const ACCOUNT_A = '1234567890abcdef1234567890abcdef';
const ACCOUNT_B = 'abcdef1234567890abcdef1234567890';

function exchangeBody(overrides = {}) {
  return { api_key: DELEGATED_KEY, account_id: ACCOUNT_A,
    expires_at: new Date(Date.now() + 60_000).toISOString(), scope: 'mcp:read',
    resource: OAUTH_RESOURCE, ...overrides };
}

function exchangeResponse(body = exchangeBody(), options = {}) {
  return new Response(JSON.stringify(body), {
    ...options, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...options.headers },
  });
}

function oauthPost(origin, { token = OAUTH_TOKEN_A, headers = {}, ...options } = {}) {
  return postAnonymous(origin, { path: '/oauth/mcp', body: callSports(),
    ...options, headers: { 'mcp-protocol-version': '2025-11-25',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
}

test('OAuth is disabled without its service secret and discovery advertises the exact protected resource when enabled', async () => {
  let reads = 0;
  const disabled = await hosted(async () => { reads += 1; return response({ sports: [] }); });
  try {
    assert.equal((await fetch(`${disabled.origin}${OAUTH_METADATA_PATH}`)).status, 404);
    assert.equal((await oauthPost(disabled.origin)).status, 503);
    assert.equal((await postAnonymous(disabled.origin)).status, 200);
    assert.equal(reads, 0);
  } finally { await disabled.close(); }
  assert.throws(() => createHostedServer({ publicOrigin: 'https://mcp.example.com', exchangeSecret: 'two secrets' }), /configuration/);

  const service = await hosted(async () => { reads += 1; return response({ sports: [] }); }, { exchangeSecret: EXCHANGE_SECRET });
  try {
    const metadata = await fetch(`${service.origin}${OAUTH_METADATA_PATH}`);
    assert.equal(metadata.status, 200);
    assert.equal(metadata.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await metadata.json(), { resource: OAUTH_RESOURCE,
      authorization_servers: [OAUTH_ISSUER], scopes_supported: ['mcp:read'], bearer_methods_supported: ['header'] });
    const rejected = await oauthPost(service.origin, { token: null });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get('www-authenticate'),
      `Bearer resource_metadata="${service.origin}${OAUTH_METADATA_PATH}", scope="mcp:read"`);
    for (const body of [REQUEST, { jsonrpc: '2.0', id: 7, method: 'tools/list' },
      { jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: 'therundown://brief' } }]) {
      const result = await oauthPost(service.origin, { token: null, body });
      assert.equal(result.status, 200);
      if (body.method === 'tools/list') {
        const tools = (await result.json()).result.tools;
        assert.equal(tools.length, 6);
        for (const tool of tools) {
          assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['mcp:read'] }]);
          assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes);
        }
      }
    }
    assert.equal(reads, 0);
  } finally { await service.close(); }
});

test('OAuth resolves every data request separately and only delegates the signed credential to Product', async () => {
  const calls = [];
  const service = await hosted(async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === OAUTH_EXCHANGE_URL) return exchangeResponse();
    return response({ affiliates: [{ affiliate_id: 27, affiliate_name: 'Retired' },
      { affiliate_id: 19, affiliate_name: 'Published' }] });
  }, { exchangeSecret: EXCHANGE_SECRET });
  try {
    const body = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_affiliates', arguments: {} } };
    for (let i = 0; i < 2; i += 1) {
      const result = await oauthPost(service.origin, { body });
      assert.equal(result.status, 200);
      assert.deepEqual((await result.json()).result.structuredContent.data.affiliates,
        [{ affiliate_id: 19, affiliate_name: 'Published' }]);
    }
    assert.equal(calls.length, 4);
    for (const { url, options } of calls) {
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      if (url === OAUTH_EXCHANGE_URL) {
        assert.equal(options.method, 'POST');
        assert.equal(options.cache, 'no-store');
        assert.equal(options.headers.Authorization, `Bearer ${OAUTH_TOKEN_A}`);
        assert.equal(options.headers['X-TheRundown-MCP-Service'], EXCHANGE_SECRET);
        assert.deepEqual(JSON.parse(options.body), { resource: OAUTH_RESOURCE });
        assert.equal(options.headers['X-TheRundown-Key'], undefined);
      } else {
        assert.equal(url, 'https://therundown.io/api/v2/affiliates');
        assert.equal(options.method, 'GET');
        assert.equal(options.headers['X-TheRundown-Key'], DELEGATED_KEY);
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.headers['X-TheRundown-MCP-Service'], undefined);
      }
    }
  } finally { await service.close(); }
});

test('OAuth rejects raw key headers, aliases, duplicated or ambiguous tokens and credential URLs before exchange', async () => {
  let reads = 0;
  const service = await hosted(async () => { reads += 1; return exchangeResponse(); }, { exchangeSecret: EXCHANGE_SECRET });
  try {
    for (const headers of [{ 'X-TheRundown-Key': KEY_A }, { 'X-API-Key': KEY_A },
      { Authorization: 'Basic synthetic' }, { Authorization: `Bearer ${OAUTH_TOKEN_A},${OAUTH_TOKEN_B}` }]) {
      assert.equal((await oauthPost(service.origin, { headers })).status, 401);
    }
    assert.equal((await rawRequest(service.origin, { path: '/oauth/mcp', body: callSports(), headers: {
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
      Authorization: [`Bearer ${OAUTH_TOKEN_A}`, `Bearer ${OAUTH_TOKEN_A}`],
    } })).status, 401);
    assert.equal((await oauthPost(service.origin, { path: `/oauth/mcp?token=${OAUTH_TOKEN_A}` })).status, 403);
    for (const path of ['/oauth/x/../mcp', '/oauth/%6dcp', '/oauth//mcp', '/x/../mcp', '/%6dcp']) {
      assert.equal((await rawRequest(service.origin, { path, body: callSports(), headers: {
        Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
        Authorization: `Bearer ${OAUTH_TOKEN_A}`,
      } })).status, 403);
    }
    assert.equal(reads, 0);
  } finally { await service.close(); }
});

test('OAuth exchange failures preserve sanitized HTTP status and never fall back to Product or retry', async () => {
  let status = 401;
  let exchanges = 0;
  let products = 0;
  const service = await hosted(async (url) => {
    if (String(url) !== OAUTH_EXCHANGE_URL) { products += 1; return response({ sports: [] }); }
    exchanges += 1;
    return exchangeResponse({ error: `${OAUTH_TOKEN_A} ${EXCHANGE_SECRET} ${DELEGATED_KEY}` }, { status, headers: { 'retry-after': '7' } });
  }, { exchangeSecret: EXCHANGE_SECRET });
  try {
    for (status of [401, 403, 429, 500, 302]) {
      const result = await oauthPost(service.origin, { token: KEY_A });
      assert.equal(result.status, [401, 403, 429].includes(status) ? status : 503);
      const text = await result.text();
      for (const secret of [OAUTH_TOKEN_A, EXCHANGE_SECRET, DELEGATED_KEY, KEY_A]) assert.equal(text.includes(secret), false);
      if (status === 401) assert.match(result.headers.get('www-authenticate'), /resource_metadata=/);
      if (status === 429) {
        assert.equal(JSON.parse(text).error.data.limit_reason, null);
        assert.equal(result.headers.get('retry-after'), '7');
        assert.equal(JSON.parse(text).error.data.retry_after, 7);
      }
    }
    assert.equal(exchanges, 5);
    assert.equal(products, 0);
  } finally { await service.close(); }
});

test('OAuth refuses malformed, oversized, expired, long-lived or incorrectly scoped exchange credentials', async () => {
  let reply = () => exchangeResponse();
  let products = 0;
  const service = await hosted(async (url) => {
    if (String(url) === OAUTH_EXCHANGE_URL) return reply();
    products += 1;
    return response({ sports: [] });
  }, { exchangeSecret: EXCHANGE_SECRET });
  try {
    const invalid = [null, [], exchangeBody({ extra: true }), exchangeBody({ api_key: KEY_A }),
      exchangeBody({ api_key: 'mcp1.two keys' }), exchangeBody({ api_key: 'mcp1.raw:signed:blob' }),
      exchangeBody({ api_key: 'mcp1.a' }),
      exchangeBody({ api_key: 'mcp1.' + 'a'.repeat(4096) }), exchangeBody({ account_id: 'unknown' }),
      exchangeBody({ expires_at: 'invalid' }), exchangeBody({ expires_at: new Date(Date.now() - 1000).toISOString() }),
      exchangeBody({ expires_at: new Date(Date.now() + 120_000).toISOString() }),
      exchangeBody({ scope: 'mcp:write' }), exchangeBody({ resource: 'https://other.example/oauth/mcp' })];
    for (const value of invalid) {
      reply = () => exchangeResponse(value);
      assert.equal((await oauthPost(service.origin)).status, 503);
    }
    for (const build of [() => new Response('{bad json', { headers: { 'content-type': 'application/json' } }),
      () => exchangeResponse(exchangeBody(), { headers: { 'content-type': 'text/plain' } }),
      () => exchangeResponse(exchangeBody({ pad: 'x'.repeat(16 * 1024) })),
      () => exchangeResponse(exchangeBody(), { headers: { 'content-length': '16385' } })]) {
      reply = build;
      assert.equal((await oauthPost(service.origin)).status, 503);
    }
    assert.equal(products, 0);
  } finally { await service.close(); }
});

test('OAuth limits concurrent tokens and accounts while different accounts stay isolated', async () => {
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  let complete;
  const hold = new Promise((resolve) => { complete = resolve; });
  let exchangeCount = 0;
  let productCount = 0;
  const service = await hosted(async (url, options) => {
    if (String(url) === OAUTH_EXCHANGE_URL) {
      exchangeCount += 1;
      return exchangeResponse(exchangeBody({ account_id: options.headers.Authorization.endsWith('other-account') ? ACCOUNT_B : ACCOUNT_A }));
    }
    productCount += 1;
    if (productCount === 1) { began(); await hold; }
    return response({ sports: [] });
  }, { exchangeSecret: EXCHANGE_SECRET, maxConcurrent: 3 });
  try {
    const first = oauthPost(service.origin);
    await started;
    assert.equal((await oauthPost(service.origin)).status, 429);
    assert.equal(exchangeCount, 1, 'same active token should fail before exchange');
    assert.equal((await oauthPost(service.origin, { token: OAUTH_TOKEN_B })).status, 429);
    assert.equal(productCount, 1, 'another token for the active account must not reach Product');
    assert.equal((await oauthPost(service.origin, { token: 'other-account' })).status, 200);
    complete();
    assert.equal((await first).status, 200);
    assert.equal((await oauthPost(service.origin, { token: OAUTH_TOKEN_B })).status, 200);
  } finally { complete(); await service.close(); }
});

test('OAuth exchange response cancellation holds request capacity until the upstream cancellation settles', async () => {
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  let aborted;
  const cancelled = new Promise((resolve) => { aborted = resolve; });
  let exchanges = 0;
  let products = 0;
  const service = await hosted(async (url) => {
    if (String(url) !== OAUTH_EXCHANGE_URL) { products += 1; return response({ sports: [] }); }
    exchanges += 1;
    if (exchanges > 1) return exchangeResponse();
    let sent = false;
    return new Response(new ReadableStream({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('{"api_key":')); began(); return; }
        return new Promise(() => {});
      },
      cancel() { aborted(); return new Promise((resolve) => setTimeout(resolve, 40)); },
    }), { headers: { 'content-type': 'application/json' } });
  }, { exchangeSecret: EXCHANGE_SECRET, requestTimeoutMs: 30 });
  try {
    const first = oauthPost(service.origin);
    await started;
    await cancelled;
    assert.equal((await oauthPost(service.origin)).status, 429);
    assert.equal((await first).status, 408);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await oauthPost(service.origin)).status, 200);
    assert.equal(products, 1);
  } finally { await service.close(); }
});

test('OAuth works with the actual Streamable HTTP client and redacts delegated credentials from tool output', async () => {
  let exchanges = 0;
  let products = 0;
  const service = await hosted(async (url) => {
    if (String(url) === OAUTH_EXCHANGE_URL) { exchanges += 1; return exchangeResponse(); }
    products += 1;
    return response({ sports: [{ sport_id: 3, sport_name: `MLB ${DELEGATED_KEY}` }] });
  }, { exchangeSecret: EXCHANGE_SECRET });
  const transport = new StreamableHTTPClientTransport(new URL(`${service.origin}/oauth/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${OAUTH_TOKEN_A}` } },
  });
  const client = new Client({ name: 'oauth-integration-test', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 6);
    for (const tool of tools) assert.deepEqual(tool._meta.securitySchemes, [{ type: 'oauth2', scopes: ['mcp:read'] }]);
    assert.equal((await client.listResources()).resources[0].uri, 'therundown://brief');
    assert.equal(exchanges, 0);
    const result = await client.callTool({ name: 'list_sports', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(JSON.stringify(result).includes(DELEGATED_KEY), false);
    assert.match(JSON.stringify(result), /REDACTED/);
    assert.equal(exchanges, 1);
    assert.equal(products, 1);
  } finally { await Promise.allSettled([client.close(), transport.close()]); await service.close(); }
});

test('OAuth client disconnect aborts exchange and holds token admission until the fetch settles', async () => {
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  let aborted;
  const cancelled = new Promise((resolve) => { aborted = resolve; });
  let exchanges = 0;
  const service = await hosted((url, options) => {
    if (String(url) !== OAUTH_EXCHANGE_URL) return Promise.resolve(response({ sports: [] }));
    exchanges += 1;
    if (exchanges > 1) return Promise.resolve(exchangeResponse());
    return new Promise((_resolve, reject) => {
      began();
      options.signal.addEventListener('abort', () => {
        aborted();
        setTimeout(() => reject(new DOMException('Cancelled', 'AbortError')), 40);
      }, { once: true });
    });
  }, { exchangeSecret: EXCHANGE_SECRET });
  const request = httpRequest(`${service.origin}/oauth/mcp`, { method: 'POST', headers: {
    accept: 'application/json, text/event-stream', 'content-type': 'application/json',
    'mcp-protocol-version': '2025-11-25', Authorization: `Bearer ${OAUTH_TOKEN_A}`,
  } });
  request.on('error', () => {});
  request.end(JSON.stringify(callSports()));
  try {
    await started;
    request.destroy();
    await cancelled;
    assert.equal((await oauthPost(service.origin)).status, 429);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await oauthPost(service.origin)).status, 200);
  } finally { request.destroy(); await service.close(); }
});

test('OAuth exchange and Product operation share the same total request deadline', async () => {
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  let aborted;
  const cancelled = new Promise((resolve) => { aborted = resolve; });
  const service = await hosted(async (url, options) => {
    if (String(url) === OAUTH_EXCHANGE_URL) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return exchangeResponse();
    }
    began();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => { aborted(); reject(new DOMException('Timed out', 'AbortError')); }, { once: true });
    });
  }, { exchangeSecret: EXCHANGE_SECRET, requestTimeoutMs: 250 });
  try {
    const before = performance.now();
    const first = oauthPost(service.origin);
    await started;
    await cancelled;
    assert.ok(performance.now() - before < 380, 'exchange must not grant a second full Product deadline');
    await first;
  } finally { await service.close(); }
});
