import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import {
  cheapestVerifiedAlternative,
  compareProductIdentity,
  matchProductCandidate,
  parsePublicProductResults,
  retailerMatchesHost,
  saveFoundProductUrl,
  saveFoundUrlBeforeVerification,
  saveVerifiedProductMatch,
  searchRetailerProductPages
} from '../server/product-discovery.js';
import { checkMonitoredProduct } from '../server/monitoring.js';
import {
  candidateUrlRejectionReason,
  cleanRetailerSearchText,
  isSuspiciousProductName,
  prepareCostcoResults,
  productPageEvidenceRejectionReason,
  productResultEvidenceRejectionReason,
  readProductLinks,
  readCostcoWarehousePrice,
  readRetailerProductPage,
  retailerSearchQueries,
  searchRetailerWebsite
} from '../server/retailer-browser.js';

const now = new Date('2026-11-04T12:00:00.000Z');

function mockSearchPage(page) {
  page.getByRole = () => ({ count: async () => 0 });
  page.waitForURL = async () => {};
  page.waitForFunction = async () => {};
  page.evaluate = async () => {};
  return page;
}

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

test('reads only a clearly labeled Costco warehouse price without unit or discount ambiguity', async t => {
  try {
    await access(chromium.executablePath());
  } catch {
    t.skip('Playwright Chromium is not installed');
    return;
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const [markup, expected] of [
      ['<div><span>Warehouse Price</span><strong>$1.49</strong></div>', 1.49],
      ['<div><span>Warehouse Price</span><strong>$1.49 per unit</strong></div>', null],
      ['<div><span>Warehouse Price</span><strong>$1.49</strong><span>Save $2.00</span></div>', null],
      ['<div><span>Warehouse Price</span><strong>$1.49</strong></div><div><span>Warehouse Price</span><strong>$9.09</strong></div>', null],
      ['<div><span>Warehouse Price</span><strong>See price in warehouse</strong></div>', null]
    ]) {
      await page.setContent(`<main><h1>Ziploc Variety Pack</h1>${markup}</main>`);
      assert.deepEqual(await page.evaluate(readCostcoWarehousePrice), { found: true, price: expected });
    }
  } finally {
    await browser.close();
  }
});

test('original retailer host matching rejects another seller as an original listing', () => {
  assert.equal(retailerMatchesHost('Costco Wholesale', 'www.costco.com'), true);
  assert.equal(retailerMatchesHost('Costco Wholesale', 'www.walmart.com'), false);
  assert.equal(retailerMatchesHost('Walmart', 'walmart.com.evil.example'), false);
  assert.equal(retailerMatchesHost('Best Buy', 'www.bestbuy.com'), true);
  assert.equal(retailerMatchesHost('The Home Depot', 'www.homedepot.com'), true);
});

test('Costco Cart and Photo navigation URLs cannot become product candidates', () => {
  for (const [url, title] of [
    ['https://www.costco.com/ShopCartDisplay', 'Cart'],
    ['https://www.costco.com/cart.html', 'Cart'],
    ['https://www.costco.com/photo-center.html', 'Photo'],
    ['https://www.costco.com/elsewhere.html', 'Photo']
  ]) {
    assert.ok(candidateUrlRejectionReason(url, 'costco.com', title), url);
  }
});

test('Costco browser extraction uses product cards and product JSON-LD, not navigation links', async t => {
  try {
    await access(chromium.executablePath());
  } catch {
    t.skip('Playwright Chromium is not installed');
    return;
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <nav>
        <a href="https://www.costco.com/ShopCartDisplay">Cart</a>
        <a href="https://www.costco.com/photo-center.html"><img alt="Photo">Photo</a>
        <a href="https://www.costco.com/customer-service.html">Orders &amp; Returns</a>
        <a href="https://www.costco.com/unrelated.html"><img alt="Avocado">Avocado</a>
      </nav>
      <div data-testid="product-card">
        <a href="https://www.costco.com/organic-avocados.product.123.html">
          Organic Avocados <img alt="Avocados">
        </a>
        <a href="https://www.costco.com/cart.html">Cart</a>
      </div>
      <script type="application/ld+json">
        {"@type":"ItemList","itemListElement":[{"item":{"@type":"Product",
          "name":"Hass Avocados","url":"https://www.costco.com/hass.product.456.html"}}]}
      </script>
    `);
    const results = await readProductLinks(page, 'costco.com');
    assert.deepEqual(results.map(result => result.url), [
      'https://www.costco.com/organic-avocados.product.123.html',
      'https://www.costco.com/hass.product.456.html'
    ]);
  } finally {
    await browser.close();
  }
});

test('Costco waits for loaded products, accepts the cookie prompt, and scrolls', async t => {
  try {
    await access(chromium.executablePath());
  } catch {
    t.skip('Playwright Chromium is not installed');
    return;
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`
      <button onclick="this.remove(); setTimeout(() => {
        const card = document.createElement('div');
        card.setAttribute('data-testid', 'product-card');
        card.innerText = 'Product';
        document.body.appendChild(card);
      }, 100)">Accept all cookies</button>
      <div style="height: 3000px"></div>
    `);
    await prepareCostcoResults(page);
    assert.equal(await page.getByRole('button', { name: 'Accept all cookies' }).count(), 0);
    assert.equal(await page.locator('[data-testid="product-card"]').count(), 1);
    assert.ok(await page.evaluate(() => window.scrollY) > 0);
  } finally {
    await browser.close();
  }
});

test('Costco no-card search falls back to public search restricted to valid Costco product URLs', async () => {
  const queries = [];
  const result = await searchRetailerProductPages(
    'Costco',
    { name: 'Avocados' },
    async query => {
      queries.push(query);
      return [
        { url: 'https://www.costco.com/cart.html', title: 'Cart' },
        { url: 'https://www.costco.com/photo-center.html', title: 'Photo' },
        { url: 'https://other.example/product/avocados', title: 'Avocados' },
        { url: 'https://www.costco.com/avocado.product.123.html', title: 'Avocados' }
      ];
    },
    async () => [],
    () => {}
  );
  assert.deepEqual(queries, ['site:costco.com Avocados']);
  assert.deepEqual(result.results.map(item => item.url), [
    'https://www.costco.com/avocado.product.123.html'
  ]);
});

test('Costco walnut discovery searches name and SKU, logs all results, and keeps only official product URLs', async () => {
  const queries = [];
  const logs = [];
  const product = {
    name: 'KS WALNUTS',
    sku: '36285',
    retailer: 'Costco',
    officialRetailerDomain: 'costco.com',
    ocrText: '/KS WALNUTS 36285'
  };
  const url = 'https://www.costco.com/kirkland-walnuts-36285';
  const result = await searchRetailerProductPages(
    'Costco', product,
    async query => {
      queries.push(query);
      return [
        { url, title: 'Kirkland Signature Walnuts' },
        { url: 'https://costco.com.evil.example/product/36285', title: 'Walnuts' },
        { url: 'https://www.costco.com/cart.html', title: 'Cart' }
      ];
    },
    async () => { throw new Error('Public search already found a candidate'); },
    (_, message) => logs.push(JSON.parse(message))
  );
  assert.deepEqual(queries, ['KS WALNUTS 36285 Costco', 'site:costco.com 36285 walnuts']);
  assert.deepEqual(result.results.map(candidate => candidate.url), [url]);
  assert.ok(logs.some(entry => entry.candidateUrls?.includes('https://costco.com.evil.example/product/36285')));
  assert.equal(product.ocrText, '/KS WALNUTS 36285');
  assert.equal(cleanRetailerSearchText('/TEE 2PK'), 'TEE 2PK');
  const match = matchProductCandidate(product, {
    title: 'Kirkland Signature Walnuts', sku: '36285'
  }, null);
  assert.equal(match.accepted, true);
  assert.equal(matchProductCandidate(product, {
    title: 'KS WALNUTS', sku: '99999'
  }, null).accepted, false);
});

test('Costco reports blocked search when all search sources fail or return nothing', async () => {
  const result = await searchRetailerProductPages(
    'Costco', { name: 'KS WALNUTS', sku: '36285' },
    async () => { throw new Error('Search unavailable'); },
    async () => [],
    () => {}
  );
  assert.deepEqual(result.results, []);
  assert.equal(result.blocked, true);
});

test('navigation-only browser results trigger the Costco public-search fallback', async () => {
  let currentUrl = '';
  const page = mockSearchPage({
    route: async () => {},
    goto: async url => { currentUrl = url; return { ok: () => true }; },
    url: () => currentUrl,
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    locator(selector) {
      if (selector === 'a[href]') {
        return { evaluateAll: async () => [
          { url: 'https://www.costco.com/ShopCartDisplay', title: 'Cart', image: true },
          { url: 'https://www.costco.com/photo-center.html', title: 'Photo', image: true }
        ] };
      }
      return { first() { return this; }, count: async () => 0 };
    }
  });
  const browser = {
    newContext: async () => ({ newPage: async () => page, close: async () => {} }),
    close: async () => {}
  };
  const queries = [];
  const result = await searchRetailerProductPages(
    'Costco',
    { name: 'Avocados' },
    async query => {
      queries.push(query);
      return [{ url: 'https://www.costco.com/avocado.product.123.html', title: 'Avocados' }];
    },
    options => searchRetailerWebsite({
      ...options,
      launchBrowser: async () => browser,
      logger: () => {}
    }),
    () => {}
  );
  assert.deepEqual(queries, ['site:costco.com Avocados']);
  assert.deepEqual(result.results.map(item => item.url), [
    'https://www.costco.com/avocado.product.123.html'
  ]);
});

test('identity matching does not call Groq for a clearly different product', async () => {
  let calls = 0;
  const compare = async () => {
    calls++;
    return { equivalent: true, sameVariant: true, sameCondition: true, confidence: 0.99 };
  };
  const product = { name: 'Ninja Crispi Air Fryer', brand: 'Ninja', model: 'FN101' };
  const different = await compareProductIdentity(product, {
    title: 'Ninja Crispi Air Fryer FN102', brand: 'Ninja', model: 'FN102'
  }, compare);
  assert.equal(different.match.accepted, false);
  assert.equal(different.identityComparisonSkipped, true);
  assert.equal(calls, 0);
  const matching = await compareProductIdentity(product, {
    title: 'Ninja Crispi Air Fryer FN101', brand: 'Ninja', model: 'FN101'
  }, compare);
  assert.equal(matching.match.accepted, true);
  assert.equal(calls, 1);
});

test('Costco navigation, search, login, and support URLs are rejected before ranking', () => {
  const rejected = [
    'https://www.costco.com/consumer-health-data-privacy-policy.html',
    'https://www.costco.com/costco-app.html',
    'https://www.costco.com/LogonForm',
    'https://www.costco.com/ShopCartDisplay',
    'https://www.costco.com/photo-center.html',
    'https://www.costco.com/OrderStatusCmd',
    'https://www.costco.com/warehouse-locations',
    'https://www.costco.com/concierge.html',
    'https://www.costco.com/s?keyword=avocado',
    'https://www.costco.com/customer-service.html',
    'https://www.costco.com/'
  ];
  for (const url of rejected) {
    assert.ok(
      candidateUrlRejectionReason(url, 'costco.com', 'Avocado') ,
      `expected ${url} to be rejected`
    );
  }
  assert.equal(
    candidateUrlRejectionReason(
      'https://www.costco.com/organic-hass-avocado.product.40001234.html',
      'costco.com',
      'Organic Hass Avocado'
    ),
    ''
  );
  assert.equal(candidateUrlRejectionReason(
    'https://www.costco.com/organic-hass-avocado',
    'costco.com',
    'Organic Hass Avocado'
  ), '');
});

test('a candidate page needs a title and product-specific evidence', () => {
  assert.match(productPageEvidenceRejectionReason({
    title: 'Costco Consumer Privacy Policy',
    productTitle: false
  }), /no product title/i);
  assert.match(productPageEvidenceRejectionReason({
    title: 'Generic Costco page',
    productTitle: true
  }), /no product schema/i);
  assert.equal(productPageEvidenceRejectionReason({
    title: 'Organic Hass Avocado',
    productTitle: true,
    productSchema: true
  }), '');
  assert.equal(productPageEvidenceRejectionReason({
    title: 'Organic Hass Avocado',
    productTitle: true,
    productSku: true
  }), '');
});

test('a search result needs at least two product-specific evidence signals', () => {
  assert.match(productResultEvidenceRejectionReason({
    title: 'Organic Avocados, 6 Count'
  }), /fewer than two/i);
  assert.equal(productResultEvidenceRejectionReason({
    title: 'Organic Avocados, 6 Count',
    image: true
  }), '');
});

test('product discovery scopes each merchant to its own dynamically resolved official domain', async () => {
  const retailers = [
    ['Costco Wholesale', 'https://www.costco.com/', 'costco.com'],
    ['Walmart', 'https://www.walmart.com/', 'walmart.com'],
    ['Target', 'https://www.target.com/', 'target.com'],
    ['Northstar Outfitters', 'https://northstaroutfitters.com/', 'northstaroutfitters.com']
  ];

  for (const [retailer, officialUrl, expectedDomain] of retailers) {
    const calls = [];
    const search = async query => {
      calls.push(query);
      return calls.length === 1
        ? [{ url: officialUrl, title: `${retailer} official website` }]
        : [
          { url: `${officialUrl}product/ninja-crispi`, title: 'Ninja Crispi' },
          { url: 'https://unrelated-retailer.example/product/ninja-crispi', title: 'Ninja Crispi' }
        ];
    };

    const websiteCalls = [];
    const result = await searchRetailerProductPages(
      retailer,
      { name: 'Ninja Crispi' },
      search,
      async options => {
        websiteCalls.push(options);
        return [
          { url: `${officialUrl}product/ninja-crispi`, title: 'Ninja Crispi' },
          { url: 'https://unrelated-retailer.example/product/ninja-crispi', title: 'Ninja Crispi' }
        ];
      },
      () => {}
    );

    assert.equal(result.domain, expectedDomain);
    if (expectedDomain.startsWith('northstar')) {
      assert.equal(calls[0], `${retailer} official website`);
    } else if (expectedDomain !== 'costco.com') {
      assert.equal(calls.length, 0, 'known retailers resolve without a public search');
    }
    assert.deepEqual(websiteCalls.map(call => call.domain), [expectedDomain]);
    assert.deepEqual(websiteCalls.map(call => call.retailer), [retailer]);
    assert.deepEqual(result.results.map(item => item.url), [
      `${officialUrl}product/ninja-crispi`
    ]);
  }
});

test('a single exact retailer match automatically saves its verified URL and live price', () => {
  const product = {
    name: 'Ninja Crispi',
    discoveryStatus: 'searching',
    originalUrlVerified: false
  };
  saveVerifiedProductMatch(product, {
    url: 'https://www.costco.com/ninja-crispi.html',
    price: 20,
    priceVerified: true,
    matchConfidence: 0.96,
    matchEvidence: 'Exact identity match.'
  });
  assert.equal(product.url, 'https://www.costco.com/ninja-crispi.html');
  assert.equal(product.originalUrlVerified, true);
  assert.equal(product.discoveryStatus, 'verified');
  assert.equal(product.currentVerifiedPrice, 20);
  assert.equal(product.currentPrice, 20);
});

test('a found retailer URL remains saved before identity or price verification', () => {
  const product = { discoveryStatus: 'searching' };
  assert.throws(() => saveFoundUrlBeforeVerification(
    product,
    'https://www.costco.com/organic-hass-avocado.html',
    () => {
      assert.equal(product.url, 'https://www.costco.com/organic-hass-avocado.html');
      assert.equal(product.discoveryStatus, 'found');
      throw new Error('Temporary live price extraction failure.');
    }
  ), /Temporary live price extraction failure/);
  assert.equal(product.url, 'https://www.costco.com/organic-hass-avocado.html');
  assert.equal(product.originalUrlVerified, false);
  assert.equal(product.discoveryStatus, 'found');
  assert.equal(product.discoveryStatus, 'found');
});

test('discovery builds exact-name, brand/model, SKU, and identifying-detail searches', () => {
  const queries = retailerSearchQueries({
    name: 'Ninja Crispi',
    brand: 'Ninja',
    model: 'FN101',
    sku: '12345',
    retailer: 'Costco',
    description: 'air fryer',
    size: '6-piece',
    quantity: 2,
    variant: 'black',
    bundle: '2 pack',
    condition: 'new',
    attributes: ['Glass container', '2 pack']
  });
  assert.deepEqual(queries, [
    'Ninja Crispi',
    'Ninja FN101',
    'Ninja Ninja Crispi',
    'Ninja FN101 Ninja Crispi',
    '12345',
    '6-piece',
    'black',
    '2 pack',
    'new',
    'air fryer',
    'Glass container',
    'Ninja air fryer',
    'Costco Ninja Crispi',
    'Ninja',
    'Crispi'
  ]);
  assert.equal(cleanRetailerSearchText('AVOCADOS $5.29 Tax 0.42 Total 5.71'), 'AVOCADOS');
  assert.equal(retailerSearchQueries({ name: 'AVOCADOS', purchasePrice: 5.29 })[0], 'AVOCADOS');
  assert.equal(retailerSearchQueries({ name: 'FRESH GARLIC', price: 5.29 })[0], 'FRESH GARLIC');
  assert.deepEqual(retailerSearchQueries({ name: '5.29 each tax total' }), []);
});

test('browser searches retailer pages and logs query URLs and candidate URLs', async () => {
  const searchedQueries = [];
  const logs = [];
  let currentUrl = '';
  const page = {
    route: async () => {},
    goto: async url => {
      currentUrl = url;
      return { ok: () => true };
    },
    url: () => currentUrl,
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    locator(selector) {
      if (selector === 'a[href]') {
        return {
          evaluateAll: async callback => {
            if (callback.toString().includes('anchor.rel ===')) return [];
            return searchedQueries.at(-1) === 'Ninja Crispi'
              ? [{
                url: 'https://www.walmart.com/ip/ninja-crispi/123',
                title: 'Ninja Crispi',
                image: true
              }]
              : [];
          }
        };
      }
      return {
        first() { return this; },
        count: async () => 1,
        isVisible: async () => true,
        fill: async query => { page.currentQuery = query; },
        press: async () => { searchedQueries.push(page.currentQuery); }
      };
    }
  };
  const browser = {
    newContext: async () => ({
      newPage: async () => mockSearchPage(page),
      close: async () => {}
    }),
    close: async () => {}
  };

  const results = await searchRetailerWebsite({
    retailer: 'Walmart',
    domain: 'walmart.com',
    product: { name: 'Ninja Crispi', brand: 'Ninja', model: 'FN101' },
    launchBrowser: async () => browser,
    validateUrl: async () => {},
    logger: (...args) => logs.push(args.join(' '))
  });

  assert.equal(searchedQueries[0], 'Ninja Crispi');
  assert.equal(results[0].url, 'https://www.walmart.com/ip/ninja-crispi/123');
  assert.ok(logs.some(line => line.includes('"event":"search_query"') &&
    line.includes('walmart.com')));
  assert.ok(logs.some(line => line.includes('"event":"search_results"') &&
    line.includes('ninja-crispi/123')));
});

test('retailer search finds an avocado candidate despite a receipt spelling error', async () => {
  const queries = [];
  const logs = [];
  let currentUrl = '';
  let searchNumber = 0;
  const page = {
    route: async () => {},
    goto: async url => {
      currentUrl = url;
      return { ok: () => true };
    },
    url: () => currentUrl,
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    locator(selector) {
      if (selector === 'a[href]') {
        return {
          evaluateAll: async callback => {
            if (callback.toString().includes('anchor.rel ===')) return [];
            return searchNumber > 0
              ? [{
                url: 'https://www.costco.com/organic-hass-avocado.product.123.html',
                title: 'Organic Hass Avocado',
                image: true
              }]
              : [];
          }
        };
      }
      return {
        first() { return this; },
        count: async () => 1,
        isVisible: async () => true,
        fill: async query => { page.currentQuery = query; },
        press: async () => {
          queries.push(page.currentQuery);
          searchNumber++;
        }
      };
    }
  };
  const browser = {
    newContext: async () => ({
      newPage: async () => mockSearchPage(page),
      close: async () => {}
    }),
    close: async () => {}
  };
  const results = await searchRetailerWebsite({
    retailer: 'Costco',
    domain: 'costco.com',
    product: {
      name: 'Organic avacado',
      description: 'Hass avocado'
    },
    launchBrowser: async () => browser,
    validateUrl: async () => {},
    logger: (...args) => logs.push(args.join(' '))
  });

  assert.ok(queries.includes('Organic avacado'));
  assert.equal(queries[0], 'Organic avacado');
  assert.ok(results.some(result =>
    result.url === 'https://www.costco.com/organic-hass-avocado.product.123.html'
  ));
  assert.ok(logs.some(line => line.includes('"event":"first_valid_product_selected"') &&
    line.includes('organic-hass-avocado.product.123.html')));
});

test('browser returns matching product cards with at least two evidence signals', async () => {
  const logs = [];
  let currentUrl = '';
  const links = [
    { url: 'https://www.costco.com/costco-app.html', title: 'Costco App', image: true },
    {
      url: 'https://www.costco.com/avocados.product.1.html',
      title: 'Avocados'
    },
    {
      url: 'https://www.costco.com/organic-avocados.product.2.html',
      title: 'Organic Avocados, 6 Count',
      image: true,
      price: true
    },
    {
      url: 'https://www.costco.com/avocados-12-count.product.3.html',
      title: 'Avocados, 12 Count',
      image: true,
      price: true
    }
  ];
  const page = {
    route: async () => {},
    goto: async url => {
      currentUrl = url;
      return { ok: () => true };
    },
    url: () => currentUrl,
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    locator(selector) {
      if (selector === 'a[href]') {
        return {
          evaluateAll: async callback => callback.toString().includes('anchor.rel ===')
            ? []
            : links
        };
      }
      return {
        first() { return this; },
        count: async () => 1,
        isVisible: async () => true,
        fill: async query => { page.currentQuery = query; },
        press: async () => {}
      };
    }
  };
  const browser = {
    newContext: async () => ({
      newPage: async () => mockSearchPage(page),
      close: async () => {}
    }),
    close: async () => {}
  };
  const results = await searchRetailerWebsite({
    retailer: 'Costco',
    domain: 'costco.com',
    product: { name: 'AVOCADOS' },
    launchBrowser: async () => browser,
    validateUrl: async () => {},
    logger: (...args) => logs.push(args.join(' '))
  });

  assert.deepEqual(results.map(result => result.url), [
    'https://www.costco.com/organic-avocados.product.2.html',
    'https://www.costco.com/avocados-12-count.product.3.html'
  ]);
  assert.ok(logs.some(line => line.includes('costco-app.html') &&
    line.includes('navigation page')));
  assert.ok(logs.some(line => line.includes('avocados.product.1.html') &&
    line.includes('fewer than two product-specific evidence signals')));
  assert.ok(logs.some(line => line.includes('"event":"first_valid_product_selected"') &&
    line.includes('organic-avocados.product.2.html')));
});

test('retailer searches use cleaned generic product names as their primary query', async () => {
  for (const [name, expected] of [
    ['AVOCADOS $5.29 Tax 0.42 Total 5.71', 'AVOCADOS'],
    ['FRESH GARLIC $4.99', 'FRESH GARLIC']
  ]) {
    const queries = [];
    let currentUrl = '';
    const page = {
      route: async () => {},
      goto: async url => {
        currentUrl = url;
        return { ok: () => true };
      },
      url: () => currentUrl,
      waitForTimeout: async () => {},
      waitForLoadState: async () => {},
      locator(selector) {
        if (selector === 'a[href]') {
          return { evaluateAll: async () => [] };
        }
        return {
          first() { return this; },
          count: async () => 1,
          isVisible: async () => true,
          fill: async query => { page.currentQuery = query; },
          press: async () => { queries.push(page.currentQuery); }
        };
      }
    };
    const browser = {
      newContext: async () => ({
        newPage: async () => mockSearchPage(page),
        close: async () => {}
      }),
      close: async () => {}
    };
    await searchRetailerWebsite({
      retailer: 'Costco',
      domain: 'costco.com',
      product: { name, purchasePrice: 5.29 },
      launchBrowser: async () => browser,
      validateUrl: async () => {},
      logger: () => {}
    });
    assert.equal(queries[0], expected);
    assert.ok(!queries.some(query => /^\$?\d+(?:\.\d{2})?$/.test(query)));
  }
});

test('suspicious receipt names are replaced by SKU and meaningful receipt evidence searches', () => {
  const product = {
    name: 'TEE TEE',
    sku: '40001234',
    brand: 'Kirkland',
    description: 'Organic Hass avocado',
    productLineDetails: 'ORGANIC HASS AVOCADO 6CT',
    nearbyReceiptText: 'Fresh produce item',
    ocrText: 'TEE TEE 40001234'
  };
  const queries = retailerSearchQueries(product);
  assert.equal(isSuspiciousProductName(product.name), true);
  assert.ok(queries.includes('40001234'));
  assert.ok(queries.some(query => query.includes('Organic Hass avocado')));
  assert.ok(queries.some(query => query.includes('ORGANIC HASS AVOCADO 6CT')));
  assert.ok(!queries.some(query => /\bTEE\b/i.test(query)));
});

test('browser logs rejected Costco navigation candidates and returns only product URLs', async () => {
  let currentUrl = '';
  const logs = [];
  const links = [
    {
      url: 'https://www.costco.com/consumer-health-data-privacy-policy.html',
      title: 'Consumer Health Data Privacy Policy'
    },
    { url: 'https://www.costco.com/costco-app.html', title: 'Costco App' },
    { url: 'https://www.costco.com/LogonForm', title: 'Sign In' },
    { url: 'https://www.costco.com/OrderStatusCmd', title: 'Order Status' },
    { url: 'https://www.costco.com/warehouse-locations', title: 'Warehouse Locations' },
    { url: 'https://www.costco.com/concierge.html', title: 'Concierge Services' },
    { url: 'https://www.costco.com/s?keyword=avocado', title: 'Search Results' },
    {
      url: 'https://www.costco.com/organic-hass-avocado.product.40001234.html',
      title: 'Organic Hass Avocado',
      image: true
    }
  ];
  const page = {
    route: async () => {},
    goto: async url => {
      currentUrl = url;
      return { ok: () => true };
    },
    url: () => currentUrl,
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    locator(selector) {
      if (selector === 'a[href]') {
        return {
          evaluateAll: async callback => callback.toString().includes('anchor.rel ===')
            ? []
            : links
        };
      }
      return {
        first() { return this; },
        count: async () => 1,
        isVisible: async () => true,
        fill: async query => { page.currentQuery = query; },
        press: async () => {}
      };
    }
  };
  const browser = {
    newContext: async () => ({
      newPage: async () => mockSearchPage(page),
      close: async () => {}
    }),
    close: async () => {}
  };
  const results = await searchRetailerWebsite({
    retailer: 'Costco',
    domain: 'costco.com',
    product: { name: 'Organic Hass Avocado', sku: '40001234' },
    launchBrowser: async () => browser,
    validateUrl: async () => {},
    logger: (...args) => logs.push(args.join(' '))
  });

  assert.ok(results.length > 0);
  assert.ok(results.every(result => result.url.includes('organic-hass-avocado')));
  assert.ok(logs.some(line => line.includes('consumer-health-data-privacy-policy.html') &&
    line.includes('Candidate is a search, login, order, policy, location, support, or navigation page.')));
  assert.ok(logs.some(line => line.includes('OrderStatusCmd') &&
    line.includes('Candidate is a search, login, order, policy, location, support, or navigation page.')));
});

test('browser reads canonical product URL and verified live price from retailer page data', async () => {
  let navigatedUrl = '';
  let closed = false;
  const page = {
    route: async () => {},
    goto: async url => {
      navigatedUrl = url;
      return { ok: () => true };
    },
    url: () => navigatedUrl,
    waitForTimeout: async () => {},
    content: async () => `<script type="application/ld+json">
      {"@type":"Product","name":"Ninja Crispi","brand":{"name":"Ninja"}}
    </script>`,
    locator: selector => ({
      getAttribute: async () => selector === 'link[rel="canonical"]'
        ? 'https://www.walmart.com/ip/ninja-crispi/123'
        : null
    }),
    evaluate: async () => ({
      title: 'Ninja Crispi',
      brand: 'Ninja',
      model: '',
      sku: '',
      description: '',
      size: '',
      variant: '',
      bundle: '',
      quantity: '',
      condition: '',
      currency: 'USD',
      priceTexts: ['$20.00']
    })
  };
  const browser = {
    newContext: async () => ({
      newPage: async () => page,
      close: async () => {}
    }),
    close: async () => { closed = true; }
  };
  const checkedUrls = [];

  const product = await readRetailerProductPage(
    'https://www.walmart.com/ip/ninja-crispi/123',
    {
      launchBrowser: async () => browser,
      validateUrl: async url => checkedUrls.push(url)
    }
  );

  assert.equal(product.url, 'https://www.walmart.com/ip/ninja-crispi/123');
  assert.equal(product.price, 20);
  assert.equal(product.verified, true);
  assert.equal(product.priceSource, 'visible retailer price');
  assert.equal(product.title, 'Ninja Crispi');
  assert.ok(checkedUrls.includes('https://www.walmart.com/ip/ninja-crispi/123'));
  assert.equal(closed, true);
});

test('browser and page setup failures still close every created Playwright resource', async () => {
  for (const operation of ['search', 'read']) {
    for (const failureStage of ['newContext', 'newPage', 'route']) {
      const closed = [];
      const page = {
        route: async () => {
          if (failureStage === 'route') throw new Error(`${failureStage} setup failed`);
        },
        close: async () => closed.push('page')
      };
      const context = {
        newPage: async () => {
          if (failureStage === 'newPage') throw new Error(`${failureStage} setup failed`);
          return page;
        },
        close: async () => closed.push('context')
      };
      const browser = {
        newContext: async () => {
          if (failureStage === 'newContext') throw new Error(`${failureStage} setup failed`);
          return context;
        },
        close: async () => closed.push('browser')
      };
      const expected = failureStage === 'newContext'
        ? ['browser']
        : failureStage === 'newPage'
          ? ['context', 'browser']
          : ['page', 'context', 'browser'];
      const run = operation === 'search'
        ? searchRetailerWebsite({
          retailer: 'Costco',
          domain: 'costco.com',
          product: { name: 'Organic Hass Avocado' },
          launchBrowser: async () => browser,
          logger: () => {}
        })
        : readRetailerProductPage(
          'https://www.costco.com/organic-hass-avocado.product.123.html',
          { launchBrowser: async () => browser }
        );

      await assert.rejects(run, new RegExp(`${failureStage} setup failed`));
      assert.deepEqual(closed, expected, `${operation} after ${failureStage} failure`);
    }
  }
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
  // With the AI unavailable, only a model-level identity match may be accepted.
  assert.equal(matchProductCandidate(product, candidate, null).accepted, true);
  assert.equal(matchProductCandidate({ name: 'Ninja Crispi Air Fryer', brand: 'Ninja' }, candidate, null).accepted, false);
  assert.equal(matchProductCandidate(product, {
    ...candidate,
    title: 'Ninja Crispi Air Fryer FN102',
    model: 'FN102'
  }, matchingAssessment).accepted, false);
  assert.equal(matchProductCandidate(product, {
    ...candidate,
    verified: false,
    sku: ''
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
  assert.equal(matchProductCandidate({
    ...product,
    sku: 'receipt-sku'
  }, {
    ...candidate,
    sku: ''
  }, matchingAssessment).accepted, false);
});

test('AI-confirmed product identity tolerates receipt OCR spelling errors', () => {
  const result = matchProductCandidate(
    { name: 'Organic avacado', description: 'Hass avocado' },
    {
      title: 'Organic Hass Avocado',
      description: 'Fresh organic Hass avocados'
    },
    {
      equivalent: true,
      confidence: 0.94,
      sameVariant: true,
      sameCondition: true,
      reason: 'Matching organic Hass avocado product.'
    }
  );
  assert.equal(result.accepted, true);
  assert.equal(result.priceVerified, false);
});

test('a repeated OCR name can match using receipt line details and SKU', () => {
  const result = matchProductCandidate(
    {
      name: 'TEE TEE',
      sku: '40001234',
      productLineDetails: 'ORGANIC HASS AVOCADO 6CT'
    },
    {
      title: 'Organic Hass Avocado 6 Count',
      sku: '40001234',
      productSchema: true
    },
    {
      equivalent: true,
      confidence: 0.96,
      sameVariant: true,
      sameCondition: true,
      reason: 'Matching produce SKU and line details.'
    }
  );
  assert.equal(result.accepted, true);
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
  assert.equal(result.status, 'MONITORING');
  assert.equal(product.currentVerifiedPrice, 159.99);
  assert.equal(sendCount, 0);
});

test('a verified discovery starts retailer price monitoring immediately', async () => {
  const product = {
    name: 'Ninja Crispi',
    purchasePrice: 50,
    purchaseDate: '2026-11-03',
    date: '2026-11-03',
    discoveryStatus: 'found',
    url: 'https://www.costco.com/ninja-crispi.product.1.html',
    originalUrlVerified: false
  };
  saveVerifiedProductMatch(product, {
    url: product.url,
    price: null,
    priceVerified: false,
    matchConfidence: 0.98,
    matchEvidence: 'Verified product identity.'
  });
  let priceChecks = 0;
  await checkMonitoredProduct({
    product,
    purchaseDate: product.purchaseDate,
    now,
    intervalMs: 60_000,
    fetchVerifiedPrice: async () => {
      priceChecks++;
      return { price: 20, currency: 'USD', verified: true };
    },
    sendNotification: async () => {}
  });
  assert.equal(priceChecks, 1);
  assert.equal(product.monitoringStatus, 'ON WATCH');
  assert.equal(product.priceStatus, 'PRICE DROP DETECTED');
});
