import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicProductData } from '../public-response.mjs';

test('public payloads preserve source-backed identities and freshness while removing credential/internal fields', () => {
  const payload = {
    source_id: 'public-source', affiliate_source_ids: { 19: 'book-map', 27: 'retired-map' },
    participants: [{ id: 27, source_id: 'public-player', updated_at: '2026-10-03T00:00:00Z',
      provider_id: 'private-provider', accessToken: 'private-token', api_key: 'private-key' }],
    request_id: 'private-trace', client_secret: 'private-secret', internal_context: 'private-context',
  };
  assert.deepEqual(publicProductData(payload), {
    source_id: 'public-source', affiliate_source_ids: { 19: 'book-map' },
    participants: [{ id: 27, source_id: 'public-player', updated_at: '2026-10-03T00:00:00Z' }],
  });
});

test('retired affiliate rows, keyed prices, V1 lines and nested hedge legs never escape', () => {
  assert.deepEqual(publicProductData({
    affiliates: [{ affiliate_id: 27 }, { affiliate_id: 19 }],
    lines: { 27: { moneyline: 100 }, 19: { moneyline: 120 } },
    line_periods: { 27: { period_full_game: { affiliate: null, price: 100 } },
      19: { period_full_game: { affiliate: null, price: 120 } } },
    prices: { 27: { price: 100 }, 19: { price: 120 } },
    opportunities: [{ affiliate_id: 27, price: 100 }, { legs: [{ affiliate_id: 27 }, { affiliate_id: 23 }] }],
    hedges: [{ percent: 1.2, bets: [{ affiliate_id: 19 }, { affiliate_id: 27 }] },
      { percent: 0.5, bets: [{ affiliate_id: 19 }, { affiliate_id: 23 }] }],
  }), {
    affiliates: [{ affiliate_id: 19 }], lines: { 19: { moneyline: 120 } },
    line_periods: { 19: { period_full_game: { affiliate: null, price: 120 } } },
    prices: { 19: { price: 120 } }, opportunities: [],
    hedges: [{ percent: 0.5, bets: [{ affiliate_id: 19 }, { affiliate_id: 23 }] }],
  });
});

test('unexpected deeply nested payloads fail closed', () => {
  let value = {};
  for (let i = 0; i < 82; i += 1) value = { next: value };
  assert.throws(() => publicProductData(value), /nesting/);
});

test('best-line and nested affiliate quotes drop as a whole instead of losing attribution', () => {
  const result = publicProductData({
    best_moneyline: { moneyline_home: 150, moneyline_away: -170,
      best_affiliate_home: { affiliate_id: 27 }, best_affiliate_away: { affiliate_id: 19 } },
    best_total: { total_over_money: 100, best_affiliate_over: { affiliate_id: 19 } },
    lines: [{ affiliate: { id: 27 }, moneyline: 150 }, { affiliate: { id: 19 }, moneyline: 110 }],
    hedges: [{ percent: 1, bets: [{ affiliate: { id: 27 } }, { affiliate: { id: 19 } }] }],
  });
  assert.deepEqual(result, {
    best_total: { total_over_money: 100, best_affiliate_over: { affiliate_id: 19 } },
    lines: [{ affiliate: { id: 19 }, moneyline: 110 }],
    hedges: [],
  });
});

test('serialized delta payloads retain their string contract without hiding credentials or retired prices', () => {
  const result = publicProductData({ deltas: [{ data: JSON.stringify({
    event_id: 'public-event', prices: { 27: { price: 120 }, 19: { price: 100 } },
    api_key: 'never-return-this',
  }) }] });
  assert.equal(typeof result.deltas[0].data, 'string');
  assert.deepEqual(JSON.parse(result.deltas[0].data), {
    event_id: 'public-event', prices: { 19: { price: 100 } },
  });
});
