import assert from 'node:assert/strict';
import test from 'node:test';
import { extractRetailerProductPage } from '../server/retailer-page.js';

test('extracts product identity and a current USD schema.org offer from the product page', () => {
  const page = extractRetailerProductPage(`
    <html><head>
      <title>Other page title</title>
      <script type="application/ld+json">
        {
          "@context":"https://schema.org",
          "@type":"Product",
          "name":"Ninja Crispi FN101",
          "brand":{"@type":"Brand","name":"Ninja"},
          "model":"FN101",
          "sku":1898552,
          "description":"Portable glass air fry cooking system",
          "image":["/images/ninja.jpg"],
          "offers":{
            "@type":"Offer",
            "price":"149.99",
            "priceCurrency":"USD",
            "availability":"https://schema.org/InStock"
          }
        }
      </script>
    </head><body></body></html>
  `, 'https://store.example/products/ninja');
  assert.equal(page.title, 'Ninja Crispi FN101');
  assert.equal(page.brand, 'Ninja');
  assert.equal(page.model, 'FN101');
  assert.equal(page.sku, '1898552');
  assert.equal(page.description, 'Portable glass air fry cooking system');
  assert.equal(page.price, 149.99);
  assert.equal(page.currency, 'USD');
  assert.equal(page.verified, true);
  assert.equal(page.productTitle, true);
  assert.equal(page.productSchema, true);
  assert.equal(page.productSku, true);
  assert.equal(page.productDetails, true);
  assert.equal(page.imageUrl, 'https://store.example/images/ninja.jpg');
});

test('product identity remains usable for URL matching when no verified price is published', () => {
  const page = extractRetailerProductPage(`
    <html><head>
      <meta property="og:title" content="Ninja Crispi FN101">
      <meta property="product:price:amount" content="129.99">
    </head><body></body></html>
  `, 'https://store.example/products/ninja');
  assert.equal(page.title, 'Ninja Crispi FN101');
  assert.equal(page.price, null);
  assert.equal(page.verified, false);
  assert.equal(page.productTitle, false);
  assert.equal(page.productSchema, false);
});

test('ignores out-of-stock offers and rejects non-USD prices as verified values', () => {
  const page = extractRetailerProductPage(`
    <script type="application/ld+json">
      {
        "@type":"Product",
        "name":"Ninja Crispi",
        "offers":[
          {"price":"99.99","priceCurrency":"USD","availability":"https://schema.org/OutOfStock"},
          {"price":"120.00","priceCurrency":"CAD","availability":"https://schema.org/InStock"}
        ]
      }
    </script>
  `, 'https://store.example/products/ninja');
  assert.equal(page.price, null);
  assert.equal(page.verified, false);
});
