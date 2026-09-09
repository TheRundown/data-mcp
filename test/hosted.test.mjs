import assert from 'node:assert/strict';
import { createServer as createNetServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHostedServer } from '../hosted.mjs';

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

async function clientFor(origin, key) {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { 'X-TheRundown-Key': key } },
  });
  const client = new Client({ name: 'hosted-integration-test', version: '1.0.0' }, { capabilities: {} });
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

test('rejects absent, malformed, duplicated, ambiguous, and query-string credentials before MCP handling', async () => {
  let reads = 0;
  const service = await hosted(async () => { reads += 1; return response({ sports: [] }); });
  try {
    const absent = await fetch(`${service.origin}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(REQUEST),
    });
    assert.equal(absent.status, 401);
    assert.equal((await post(service.origin, { key: undefined, authorization: 'Basic synthetic' })).status, 401);
    const ambiguous = await post(service.origin, {
      headers: { Authorization: `Bearer ${KEY_B}` },
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
