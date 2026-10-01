export const OAUTH_RESOURCE = 'https://mcp.therundown.io/oauth/mcp';
export const OAUTH_ISSUER = 'https://auth.therundown.io';
export const OAUTH_SCOPE = 'mcp:read';
export const OAUTH_METADATA_PATH = '/.well-known/oauth-protected-resource/oauth/mcp';
export const OAUTH_EXCHANGE_URL = `${OAUTH_ISSUER}/mcp/exchange/`;
const MAX_EXCHANGE_BYTES = 16 * 1024;

export const OAUTH_METADATA = Object.freeze({
  resource: OAUTH_RESOURCE,
  authorization_servers: [OAUTH_ISSUER],
  scopes_supported: [OAUTH_SCOPE],
  bearer_methods_supported: ['header'],
});

export class OAuthExchangeError extends Error {
  constructor(status, retryAfter = null) {
    super('OAuth account access could not be resolved.');
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function boundedJson(response) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_EXCHANGE_BYTES)) {
    await response.body?.cancel();
    throw new OAuthExchangeError(503);
  }
  if (!response.body) throw new OAuthExchangeError(503);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_EXCHANGE_BYTES) throw new OAuthExchangeError(503);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// No token or credential cache. Every protected request checks the live grant
// and selected account through the fixed Citizen endpoint before Product work.
export async function exchangeOAuthCredential(token, secret, fetchImpl, signal) {
  try {
    const response = await fetchImpl(OAUTH_EXCHANGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-TheRundown-MCP-Service': secret,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ resource: OAUTH_RESOURCE }),
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
    if (!response.ok) {
      const rawRetry = response.headers.get('retry-after');
      const retryAfter = response.status === 429 && /^\d{1,6}$/.test(rawRetry ?? '')
        ? Number(rawRetry) : null;
      await response.body?.cancel();
      throw new OAuthExchangeError([401, 403, 429].includes(response.status) ? response.status : 503, retryAfter);
    }
    if (response.status !== 200
      || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      await response.body?.cancel();
      throw new OAuthExchangeError(503);
    }
    const value = await boundedJson(response);
    const names = ['api_key', 'account_id', 'expires_at', 'scope', 'resource'];
    const expires = typeof value?.expires_at === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.expires_at)
      ? Date.parse(value.expires_at) : NaN;
    const now = Date.now();
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== names.length || !names.every((name) => Object.hasOwn(value, name))
      || typeof value.api_key !== 'string' || value.api_key.length > 4096
      || !/^mcp1\.[A-Za-z0-9_-]+$/.test(value.api_key)
      || Buffer.from(value.api_key.slice(5), 'base64url').toString('base64url') !== value.api_key.slice(5)
      || typeof value.account_id !== 'string' || !/^[a-f0-9]{32}$/.test(value.account_id)
      || !Number.isFinite(expires) || expires <= now || expires > now + 65_000
      || value.scope !== OAUTH_SCOPE || value.resource !== OAUTH_RESOURCE) {
      throw new OAuthExchangeError(503);
    }
    return { apiKey: value.api_key, accountId: value.account_id };
  } catch (error) {
    if (signal.aborted) throw error;
    throw error instanceof OAuthExchangeError ? error : new OAuthExchangeError(503);
  }
}
