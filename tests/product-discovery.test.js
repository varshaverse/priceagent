import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cheapestVerifiedAlternative,
  matchProductCandidate,
  parsePublicProductResults,
  retailerMatchesHost
} from '../server/product-discovery.js';
import { checkMonitoredProduct } from '../server/monitoring.js';

const now = new Date('2026-11-04T12:00:00.000Z');

test('public search results provide candidate URLs only, not price evidence', () => {
  const results = parsePublicProductResults(`
    <div class="result"><a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fshop.example%2Fproduct%2F123">Ninja Crispi FN101</a></div>
    <div class="result"><a class="result__a" href="https://www.google.com/search?q=wrong">Search engine</a></div>
    <div class="result"><a class="result__a" href="https://shop.example/product/123">Duplicate</a></div>
  `);
  assert.deepEqual(results, [
    { url: 'https://shop.example/product/123', title: 'Ninja Crispi FN101' }
  ]);
  assert.equal(Object.hasOwn(results[0], 'price'), false);
});

test('original retailer host matching rejects another seller as an original listing', () => {
  assert.equal(retailerMatchesHost('Costco Wholesale', 'www.costco.com'), true);
  assert.equal(retailerMatchesHost('Costco Wholesale', 'www.walmart.com'), false);
});

test('AI product match requires verified page data and exact model, variant, and condition', () => {
  const product = {
    name: 'Ninja Crispi Air Fryer',
    brand: 'Ninja',
    model: 'FN101'
  };
  const candidate = {
    title: 'Ninja Crispi Air Fryer FN101',
    brand: 'Ninja',
    model: 'FN101',
    price: 129.99,
    currency: 'USD',
    verified: true
  };
  const matchingAssessment = {
    equivalent: true,
    confidence: 0.96,
    sameVariant: true,
    sameCondition: true,
    reason: 'Matching model and product type.'
  };
  assert.equal(matchProductCandidate(product, candidate, matchingAssessment).accepted, true);
  assert.equal(matchProductCandidate(product, {
    ...candidate,
    price: null,
    currency: '',
    verified: false
  }, matchingAssessment).accepted, true);
  assert.equal(matchProductCandidate(product, {
    ...candidate,
    price: null,
    currency: '',
    verified: false
  }, matchingAssessment).priceVerified, false);
  assert.equal(matchProductCandidate(product, candidate, null).accepted, false);
  assert.equal(matchProductCandidate(product, {
    ...candidate,
    title: 'Ninja Crispi Air Fryer FN102',
    model: 'FN102'
  }, matchingAssessment).accepted, false);
  assert.equal(matchProductCandidate(product, {
    ...candidate,
    verified: false
  }, matchingAssessment).accepted, true);
  assert.equal(matchProductCandidate(product, {
    ...candidate,
    currency: 'CAD'
  }, matchingAssessment).accepted, true);
  assert.equal(matchProductCandidate(product, {
    ...candidate,
    currency: 'CAD'
  }, matchingAssessment).priceVerified, false);
  assert.equal(matchProductCandidate(product, candidate, {
    ...matchingAssessment,
    sameVariant: false
  }).accepted, false);
});

test('cheapest alternative selection is fresh, verified, another retailer, and below current store price', () => {
  const product = {
    retailer: 'Costco',
    currentVerifiedPrice: 149.99,
    monitoringStatus: 'NO PRICE DROP',
    lastCheckedAt: '2026-11-04T11:00:00.000Z'
  };
  const offers = [
    {
      retailer: 'Walmart',
      url: 'https://walmart.example/item',
      price: 129.99,
      currency: 'USD',
      verified: true,
      matchConfidence: 0.96,
      lastVerifiedAt: '2026-11-04T11:00:00.000Z'
    },
    {
      retailer: 'Costco',
      url: 'https://costco.example/item',
      price: 119.99,
      currency: 'USD',
      verified: true,
      matchConfidence: 0.99,
      lastVerifiedAt: '2026-11-04T11:00:00.000Z'
    },
    {
      retailer: 'Target',
      url: 'https://target.example/item',
      price: 99.99,
      currency: 'USD',
      verified: false,
      matchConfidence: 0.99,
      lastVerifiedAt: '2026-11-04T11:00:00.000Z'
    },
    {
      retailer: 'Best Buy',
      url: 'https://bestbuy.example/item',
      price: 89.99,
      currency: 'USD',
      verified: true,
      matchConfidence: 0.99,
      lastVerifiedAt: '2026-11-01T11:00:00.000Z'
    },
    {
      retailer: 'Target',
      url: 'https://target.example/regular-price',
      price: 159.99,
      currency: 'USD',
      verified: true,
      matchConfidence: 0.99,
      lastVerifiedAt: '2026-11-04T11:00:00.000Z'
    }
  ];
  assert.equal(cheapestVerifiedAlternative(product, offers, now)?.url, 'https://walmart.example/item');
});

test('a cheaper alternative never triggers an original-retailer price-drop notification', async () => {
  const product = {
    name: 'Ninja Crispi Air Fryer FN101',
    retailer: 'Costco',
    purchasePrice: 159.99,
    purchaseDate: '2026-11-01',
    date: '2026-11-01',
    url: 'https://costco.example/item',
    originalUrlVerified: true,
    alternativeOffers: [{
      retailer: 'Walmart',
      price: 129.99,
      verified: true,
      lastVerifiedAt: now.toISOString()
    }]
  };
  let sendCount = 0;
  const result = await checkMonitoredProduct({
    product,
    now,
    intervalMs: 60 * 60 * 1000,
    fetchVerifiedPrice: async url => {
      assert.equal(url, product.url);
      return { price: 159.99, currency: 'USD', verified: true };
    },
    sendNotification: async () => { sendCount++; }
  });
  assert.equal(result.status, 'NO PRICE DROP');
  assert.equal(product.currentVerifiedPrice, 159.99);
  assert.equal(sendCount, 0);
});
