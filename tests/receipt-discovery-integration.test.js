import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('startup restores saved watch dates and searches each receipt merchant even without a date', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pricedrop-discovery-test-'));
  let child;
  try {
    await cp(path.join(root, 'server'), path.join(directory, 'server'), { recursive: true });
    await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    await cp(
      path.join(directory, 'server', 'product-discovery.js'),
      path.join(directory, 'server', 'product-discovery-real.js')
    );
    await writeFile(path.join(directory, 'server', 'product-discovery.js'), `
      export {
        cheapestVerifiedAlternative, compareProductIdentity, isRetailerDomain, matchProductCandidate,
        registrableDomain, resolveOfficialRetailerDomain, retailerMatchesHost,
        saveFoundUrlBeforeVerification, saveFoundProductUrl, saveVerifiedProductMatch,
        selectBestProductMatch, searchPublicProductPages
      } from './product-discovery-real.js';
      export async function searchRetailerProductPages(retailer, product) {
        console.log('TEST_SEARCH ' + JSON.stringify({ retailer, name: product.name }));
        return { domain: 'costco.com', results: [] };
      }
    `);
    await mkdir(path.join(directory, 'data'));

    const now = new Date();
    const printedDate = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${now.getFullYear()}`;
    const expectedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const receipts = [
      { id: 'dated', merchant: 'Costco', purchaseDate: null, purchaseDateEvidence: printedDate,
        products: [{ id: 'first', name: 'Example item', price: 5, purchasePrice: 5, discoveryStatus: 'searching' }] },
      { id: 'undated', merchant: 'Costco', purchaseDate: null, purchaseDateEvidence: '',
        products: [{ id: 'second', name: 'Other item', price: 5, purchasePrice: 5, discoveryStatus: 'searching' }] }
    ];
    await writeFile(path.join(directory, 'data', 'receipts.json'), JSON.stringify(receipts));
    await writeFile(path.join(directory, 'data', 'manual-products.json'), '[]');
    await writeFile(path.join(directory, 'data', 'email-settings.json'), '{}');

    const port = await unusedPort();
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, PORT: String(port), GROQ_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exit = new Promise(resolve => child.once('exit', resolve));
    const deadline = Date.now() + 10000;
    let response;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error(`Test server exited early: ${output}`);
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/receipts`);
        const data = await response.json();
        if (data.every(receipt => receipt.products[0].lastProductDiscoveryAt)) break;
      } catch {
        // The isolated server may still be starting.
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    assert.ok(response?.ok, `Server did not become ready: ${output}`);
    const results = await (await fetch(`http://127.0.0.1:${port}/api/receipts`)).json();
    assert.equal(results[0].purchaseDate, expectedDate);
    assert.equal(results[0].status, 'WATCH');
    assert.equal(results[1].status, 'PURCHASE DATE NEEDS CONFIRMATION');
    assert.ok(results.every(receipt => receipt.products[0].lastProductDiscoveryAt), output);
    assert.match(output, /TEST_SEARCH {"retailer":"Costco","name":"Example item"}/);
    assert.match(output, /TEST_SEARCH {"retailer":"Costco","name":"Other item"}/);
    const persisted = JSON.parse(await readFile(path.join(directory, 'data', 'receipts.json'), 'utf8'));
    assert.equal(persisted[0].purchaseDate, expectedDate);
    assert.ok(persisted.every(receipt => receipt.products[0].lastProductDiscoveryAt));
    for (const [url, options] of [
      ['/api/monitor/products', {
        name: 'Example item',
        retailer: 'Costco',
        purchasePrice: 5,
        url: 'https://www.costco.com/cart.html'
      }],
      ['/api/monitor/products/first/confirm-url', {
        url: 'https://www.costco.com/photo-center.html'
      }]
    ]) {
      const rejected = await fetch(`http://127.0.0.1:${port}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options)
      });
      assert.equal(rejected.status, 400);
      assert.match((await rejected.json()).error, /navigation page/);
    }
    child.kill('SIGTERM');
    await exit;
    child = null;
  } finally {
    if (child && child.exitCode == null) {
      const exit = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exit;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
