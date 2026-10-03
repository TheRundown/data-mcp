// Public Product payloads evolve independently of the adapter. Preserve their
// customer fields, including source_id mappings, but never forward credential
// fields, provider internals, or retired affiliate 27 from stale responses.
const PRIVATE_FIELDS = new Set([
  'apikey', 'apitoken', 'accesstoken', 'refreshtoken', 'authorization',
  'clientsecret', 'secret', 'token', 'password', 'passwordhash', 'cookie', 'setcookie',
  'providerid', 'providerids', 'internalid', 'internalids', 'internal',
  'debug', 'traceid', 'requestid', 'sessionid', 'internalcontext',
]);
const AFFILIATE_MAPS = new Set(['prices', 'lines', 'line_periods', 'affiliates', 'sportsbooks', 'affiliate_source_ids',
  'affiliate_deep_links', 'affiliate_deep_link_types']);
const normalize = (key) => key.toLowerCase().replace(/[^a-z0-9]/g, '');
const retiredRow = (value, parent) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.entries(value).some(([key, item]) => (['affiliateid', 'sportsbookid'].includes(normalize(key))
    || (key === 'id' && ['affiliate', 'affiliates', 'sportsbooks'].includes(parent)))
    && ['number', 'string'].includes(typeof item) && Number(item) === 27);
const retiredQuote = (value, parent) => retiredRow(value, parent)
  || retiredRow(value?.affiliate, 'affiliate')
  || (value && typeof value === 'object' && Object.entries(value).some(([key, item]) =>
    normalize(key).startsWith('bestaffiliate') && retiredRow(item, 'affiliate')));

export function publicProductData(value, parent = '', depth = 0) {
  if (depth > 80) throw new Error('Product response exceeds nesting limit');
  // Delta endpoints intentionally embed JSON in a string-valued data field.
  // Apply the same boundary inside it while preserving that public wire type.
  if (parent === 'data' && typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
    return JSON.stringify(publicProductData(JSON.parse(value), '', depth + 1) ?? null);
  }
  // Best-line objects keep quote values beside their selected affiliate. A
  // removed affiliate would otherwise leave a quote with no attributable book.
  if (retiredQuote(value, parent)) return undefined;
  // A multi-leg computed result is no longer valid if one leg is removed.
  if (['legs', 'bets'].some((field) => Array.isArray(value?.[field])
    && value[field].some((item) => retiredQuote(item)))) return undefined;
  if (Array.isArray(value)) return value.filter((item) => !(parent === 'affiliate_ids' && Number(item) === 27))
    .map((item) => publicProductData(item, parent, depth + 1))
    .filter((item) => item !== undefined);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !PRIVATE_FIELDS.has(normalize(key))
        && !(AFFILIATE_MAPS.has(parent) && key === '27'))
      .map(([key, item]) => [key, publicProductData(item, key, depth + 1)])
      .filter(([, item]) => item !== undefined));
  }
  return value;
}
