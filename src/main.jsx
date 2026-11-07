import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, Bell, Clock3, ExternalLink, Eye, PackageCheck, Plus,
  RefreshCw, Search, ShieldCheck, Trash2, TrendingDown, Upload, X
} from 'lucide-react';
import './style.css';
import './monitor.css';

const money = value => value == null || value === ''
  ? '—'
  : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));

const BACKEND_UNAVAILABLE_NOTICE = 'Cannot reach the backend on 127.0.0.1:4100. Retrying automatically…';

const localToday = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

function App() {
  const [receipts, setReceipts] = useState([]);
  const [trackedProducts, setTrackedProducts] = useState([]);
  const [monitorStats, setMonitorStats] = useState({
    monitored: 0,
    withVerifiedUrls: 0,
    awaitingUrlDiscovery: 0,
    pricesUnavailable: 0,
    priceDropsDetected: 0
  });
  const [emailRecipients, setEmailRecipients] = useState([]);
  const [savedEmailRecipients, setSavedEmailRecipients] = useState([]);
  const [emailDraft, setEmailDraft] = useState('');
  const [testRecipient, setTestRecipient] = useState('');
  const [emailOAuthConfigured, setEmailOAuthConfigured] = useState(false);
  const [gmailStatus, setGmailStatus] = useState({
    configured: false,
    connected: false,
    email: '',
    error: ''
  });
  const [testProductId, setTestProductId] = useState('');
  const [aiStatus, setAiStatus] = useState({
    provider: 'ollama',
    model: 'gemma4:e4b',
    connected: false,
    modelAvailable: false
  });
  const [page, setPage] = useState('overview');
  const [query, setQuery] = useState('');
  const [monitorQuery, setMonitorQuery] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [file, setFile] = useState(null);
  const [manualProduct, setManualProduct] = useState({
    name: '',
    retailer: '',
    brand: '',
    model: '',
    purchasePrice: '',
    purchaseDate: localToday(),
    url: '',
    returnPolicyUrl: ''
  });

  async function load() {
    try {
      const [receiptResponse, productResponse, healthResponse] = await Promise.all([
        fetch('/api/receipts'),
        fetch('/api/monitor/products'),
        fetch('/api/health')
      ]);

      const [receiptData, productData, healthData] = await Promise.all([
        receiptResponse.json(),
        productResponse.json(),
        healthResponse.json()
      ]);

      if (!receiptResponse.ok) throw new Error(receiptData.error || 'Could not load receipts.');
      if (!productResponse.ok) throw new Error(productData.error || 'Could not load monitored products.');

      setReceipts(receiptData);
      setTrackedProducts(productData.products || []);
      setMonitorStats(productData.stats || {
        monitored: 0,
        withVerifiedUrls: 0,
        awaitingUrlDiscovery: 0,
        pricesUnavailable: 0,
        priceDropsDetected: 0
      });

      setAiStatus({
        provider: healthData.aiProvider || 'ollama',
        model: healthData.aiModel || 'gemma4:e4b',
        connected: Boolean(healthData.aiConnected),
        modelAvailable: Boolean(healthData.aiModelAvailable),
        error: healthData.aiError || ''
      });

      setNotice(current =>
        current === BACKEND_UNAVAILABLE_NOTICE ? '' : current
      );

      setTestProductId(current =>
        current && productData.products.some(product =>
          product.id === current &&
          !['WATCH EXPIRED', 'PURCHASE DATE NEEDS CONFIRMATION'].includes(product.monitoringStatus)
        )
          ? current
          : productData.products.find(product =>
            !['WATCH EXPIRED', 'PURCHASE DATE NEEDS CONFIRMATION'].includes(product.monitoringStatus)
          )?.id || ''
      );
    } catch (error) {
      setNotice(BACKEND_UNAVAILABLE_NOTICE);
    }
  }

  async function loadEmailSettings() {
    try {
      const response = await fetch('/api/email/settings');
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Could not load email settings.');

      const recipients = data.recipients || [];
      setEmailRecipients(recipients);
      setSavedEmailRecipients(recipients);
      setEmailOAuthConfigured(Boolean(data.gmailOAuthConfigured));
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function loadGmailStatus() {
    try {
      const response = await fetch('/api/email/status');
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Could not verify Gmail connection.');

      setGmailStatus(data);
    } catch (error) {
      setGmailStatus({
        configured: emailOAuthConfigured,
        connected: false,
        email: '',
        error: error.message
      });
    }
  }

  useEffect(() => {
    load();
    loadEmailSettings();

    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmailResult = params.get('gmail');

    if (gmailResult) {
      if (gmailResult === 'connected') {
        setNotice('Gmail authorization completed. Checking connection status…');
        loadGmailStatus();
      } else {
        setNotice(params.get('gmail_message') || 'Gmail connection was not completed.');
      }

      params.delete('gmail');
      params.delete('gmail_message');

      const query = params.toString();

      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
      );
    } else {
      loadGmailStatus();
    }
  }, []);

  const emailConfigured = gmailStatus.connected && savedEmailRecipients.length > 0;

  const activeTrackedProducts = trackedProducts.filter(
    product => !['WATCH EXPIRED', 'PURCHASE DATE NEEDS CONFIRMATION'].includes(product.monitoringStatus)
  );

  const activeReceipts = receipts.filter(receipt => receipt.status === 'watch');
  const drops = monitorStats.priceDropsDetected;

  const filteredTrackedProducts = useMemo(() => trackedProducts.filter(product =>
    `${product.name || product.product || ''} ${product.merchant || product.retailer || ''} ${product.brand || ''} ${product.model || ''} ${product.monitoringStatus || ''}`
      .toLowerCase()
      .includes(monitorQuery.toLowerCase())
  ), [trackedProducts, monitorQuery]);

  const filteredReceipts = useMemo(() => receipts.filter(receipt =>
    `${receipt.merchant} ${receipt.fileName || ''} ${(receipt.products || []).map(product => product.name).join(' ')}`
      .toLowerCase()
      .includes(query.toLowerCase())
  ), [receipts, query]);

  async function submitReceipt(event) {
    event.preventDefault();

    if (!file) {
      setNotice('Choose a receipt file to continue.');
      return;
    }

    setBusy(true);
    setNotice('Uploading receipt and extracting purchase details…');

    try {
      const formData = new FormData();
      formData.append('receipt', file);

      const response = await fetch('/api/receipts', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Upload failed.');

      setShowUpload(false);
      setFile(null);
      await load();

      const count = (data.products || []).length;

      setNotice(`Receipt processed. Saved ${count} product${count === 1 ? '' : 's'}; open Price monitor to see each product and its watch status.`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function addManualProduct(event) {
    event.preventDefault();

    setBusy(true);
    setNotice('Saving product and verifying its current listing price…');

    try {
      const response = await fetch('/api/monitor/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manualProduct)
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Could not add product.');

      setShowManual(false);

      setManualProduct({
        name: '',
        retailer: '',
        brand: '',
        model: '',
        purchasePrice: '',
        purchaseDate: localToday(),
        url: '',
        returnPolicyUrl: ''
      });

      await load();

      setNotice(data.lastError
        ? `Product added. The listing price could not be verified yet: ${data.lastError}`
        : 'Product added and its first price check is saved.');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function runMonitor() {
    setBusy(true);
    setNotice('Checking active products…');

    try {
      const response = await fetch('/api/monitor/run', { method: 'POST' });
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || data.message || 'Price check failed.');

      const alerts = (data.results || []).filter(
        result => result.status === 'price_drop_alert_sent'
      ).length;

      setNotice(`${data.message}${alerts ? ` ${alerts} price-drop email${alerts === 1 ? '' : 's'} sent.` : ''}`);

      await load();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function testEmail() {
    setBusy(true);
    setNotice('Verifying Gmail authorization and sending a real test email…');

    try {
      const response = await fetch('/api/email/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(testProductId ? { productId: testProductId } : {}),
          ...(testRecipient.trim() ? { recipient: testRecipient.trim() } : {})
        })
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Email test failed.');

      setNotice(data.message);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  function addEmailRecipient(event) {
    event.preventDefault();

    const address = emailDraft.trim();

    if (!address) return;

    if (emailRecipients.some(
      recipient => recipient.toLowerCase() === address.toLowerCase()
    )) {
      setNotice('That recipient is already in the list.');
      return;
    }

    setEmailRecipients(current => [...current, address]);
    setEmailDraft('');
  }

  async function saveEmailRecipients() {
    setBusy(true);
    setNotice('Saving alert recipients…');

    try {
      const response = await fetch('/api/email/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: emailRecipients })
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Could not save recipients.');

      setEmailRecipients(data.recipients || []);
      setSavedEmailRecipients(data.recipients || []);

      setNotice(data.recipients.length
        ? `Price-drop alerts will be sent to ${data.recipients.join(', ')}.`
        : 'No alert recipients are saved.');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  function connectGmail() {
    window.location.assign('/api/email/oauth/connect');
  }

  async function deleteReceipt(id) {
    if (!confirm('Delete this receipt and its monitoring records?')) return;

    try {
      const response = await fetch(`/api/receipts/${id}`, { method: 'DELETE' });
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Could not delete receipt.');

      await load();
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function deleteManualProduct(id) {
    if (!confirm('Remove this manually tracked product?')) return;

    try {
      const response = await fetch(`/api/monitor/products/${id}`, {
        method: 'DELETE'
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Could not remove product.');

      await load();
    } catch (error) {
      setNotice(error.message);
    }
  }

  // FIX: These functions are siblings of deleteManualProduct,
  // not nested inside it. App can now pass them to TrackedProduct.

  async function discoverProduct(id) {
    setBusy(true);
    setNotice('Searching public listings and verifying product matches with local Gemma…');

    try {
      const response = await fetch(`/api/monitor/products/${id}/discover`, {
        method: 'POST'
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Product discovery failed.');

      await load();
      setNotice(data.message);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmProductUrl(id, url) {
    setBusy(true);

    try {
      const response = await fetch(`/api/monitor/products/${id}/confirm-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Could not confirm product URL.');

      await load();
      setNotice(data.message);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmPurchaseDate(id, purchaseDate) {
    if (!confirm(`Confirm ${purchaseDate} as the purchase date? Monitoring and email alerts will use this date.`)) return;

    setBusy(true);

    try {
      const response = await fetch(`/api/monitor/products/${id}/confirm-date`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          purchaseDate,
          confirmFutureDate: true
        })
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Could not confirm purchase date.');

      await load();
      setNotice(data.message);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  const pageInfo = {
    overview: [
      'Price monitoring dashboard',
      'Track recent purchases and catch eligible price drops before the 30-day window closes.'
    ],
    receipts: [
      'Receipts portal',
      'Review extracted purchases and their receipt-based watch status.'
    ],
    monitor: [
      'Price monitor',
      'Monitor verified product listings for 30 days from the purchase date.'
    ]
  }[page];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-icon"><TrendingDown size={21}/></div>
        <div><strong>PriceDrop</strong><span>AGENT</span></div>
      </div>

      <div className="workspace-label">WORKSPACE</div>

      <button
        className={`nav-item ${page === 'overview' ? 'selected' : ''}`}
        onClick={() => setPage('overview')}
      >
        <Activity size={18}/> Overview
      </button>

      <button
        className={`nav-item ${page === 'receipts' ? 'selected' : ''}`}
        onClick={() => setPage('receipts')}
      >
        <Upload size={18}/> Receipts portal
        <span className="nav-count">{receipts.length}</span>
      </button>

      <button
        className={`nav-item ${page === 'monitor' ? 'selected' : ''}`}
        onClick={() => setPage('monitor')}
      >
        <Eye size={18}/> Price monitor
        <span className="nav-count">{trackedProducts.length}</span>
      </button>

      <div className="sidebar-bottom">
        <div className="secure-icon"><ShieldCheck size={17}/></div>
        <div><b>Your receipts, your data</b><p>Stored locally as JSON</p></div>
      </div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div>
          <div className="eyebrow">PERSONAL SAVINGS WORKSPACE</div>
          <h1>{pageInfo[0]}</h1>
          <p className="subhead">{pageInfo[1]}</p>
        </div>

        {page === 'monitor'
          ? <button className="primary" onClick={() => setShowManual(true)}>
              <Plus size={17}/> Track a product
            </button>
          : <button className="primary" onClick={() => setShowUpload(true)}>
              <Upload size={17}/> Upload receipt
            </button>}
      </header>

      {notice && <div className="notice" role="status">
        {notice}
        <button onClick={() => setNotice('')} aria-label="Dismiss"><X size={15}/></button>
      </div>}

      {page === 'overview' && <>
        <section className="stats">
          <Stat title="Receipts uploaded" value={receipts.length} detail="Saved in your portal" icon={<PackageCheck size={18}/>} tone="purple"/>
          <Stat title="Receipts on watch" value={activeReceipts.length} detail="Purchased less than 30 days ago" icon={<Eye size={18}/>} tone="green"/>
          <Stat title="Price drops detected" value={drops} detail="Verified original-retailer prices only" icon={<Bell size={18}/>} tone="orange"/>
        </section>

        <section className="how-panel">
          <div className="how-icon"><Clock3 size={20}/></div>
          <div>
            <b>Your 30-day return-window reminder</b>
            <p>Products are checked for fewer than 30 days after purchase and leave the active watchlist on day 30. Retailer return policies vary; check the store’s terms before returning.</p>
          </div>
          <button className="text-button" onClick={runMonitor} disabled={busy}>
            <RefreshCw size={15}/> Run check
          </button>
        </section>

        <section className="receipts-section">
          <div className="section-heading">
            <div><h2>Recent receipts</h2><p>Upload receipts or add a product directly to the monitor.</p></div>
            <button className="secondary" onClick={() => setPage('monitor')}>Open price monitor</button>
          </div>

          {receipts.length
            ? <ReceiptList receipts={receipts.slice(0, 3)} onDelete={deleteReceipt}/>
            : <Empty
                icon={<Upload size={24}/>}
                title="Your receipt portal is ready"
                text="Upload a receipt to extract purchases, or open Price monitor to add a product without a receipt."
                action={<button className="primary" onClick={() => setShowUpload(true)}><Plus size={17}/> Add first receipt</button>}
              />}
        </section>
      </>}

      {page === 'receipts' && <section className="receipts-section">
        <div className="section-heading">
          <div><h2>Receipt portal</h2><p>Every uploaded receipt and its purchase details.</p></div>
          <div className="searchbox">
            <Search size={16}/>
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search receipts or products…"/>
          </div>
        </div>

        {filteredReceipts.length
          ? <ReceiptList receipts={filteredReceipts} onDelete={deleteReceipt}/>
          : <Empty
              icon={<Upload size={24}/>}
              title={receipts.length ? 'No matching receipts' : 'No receipts yet'}
              text={receipts.length ? 'Try a different search term.' : 'Receipt uploads are optional; manual tracking is available in Price monitor.'}
              action={!receipts.length && <button className="primary" onClick={() => setShowUpload(true)}><Plus size={17}/> Upload receipt</button>}
            />}
      </section>}

      {page === 'monitor' && <>
        <section className="how-panel monitor-tools">
          <div className="how-icon"><ShieldCheck size={20}/></div>

          <div className="email-settings">
            <b>Email notifications {emailConfigured ? 'are ready' : 'need setup'}</b>

            <p>{gmailStatus.connected
              ? `Gmail connected as ${gmailStatus.email || 'your Google account'}. ${emailConfigured ? 'Price-drop alerts will go to the recipients below.' : 'Add at least one recipient for price-drop alerts.'}`
              : !emailOAuthConfigured
                ? 'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in the backend .env file.'
                : gmailStatus.error || 'Connect your Google account to enable real email notifications.'}</p>

            <div className="gmail-connection">
              <span className={gmailStatus.connected ? 'connection-status connected' : 'connection-status'}>
                {gmailStatus.connected ? 'Gmail connected' : 'Gmail not connected'}
              </span>
              <button className="secondary" onClick={connectGmail} disabled={busy || !emailOAuthConfigured}>
                {gmailStatus.connected ? 'Reconnect Gmail' : 'Connect Gmail'}
              </button>
            </div>

            <div className="recipient-list" aria-label="Alert recipients">
              {emailRecipients.map(recipient => <span className="recipient-chip" key={recipient}>
                {recipient}
                <button
                  type="button"
                  aria-label={`Remove ${recipient}`}
                  onClick={() => setEmailRecipients(current => current.filter(value => value !== recipient))}
                >
                  <X size={13}/>
                </button>
              </span>)}
              {!emailRecipients.length && <span className="recipient-empty">No alert recipients added.</span>}
            </div>

            <form className="email-recipient-form" onSubmit={addEmailRecipient}>
              <input
                aria-label="Add alert recipient"
                type="email"
                maxLength={254}
                value={emailDraft}
                onChange={event => setEmailDraft(event.target.value)}
                placeholder="Add recipient (any email provider)"
              />
              <button className="secondary" disabled={busy || !emailDraft.trim()}>
                <Plus size={14}/> Add
              </button>
            </form>

            <button className="secondary save-recipients" onClick={saveEmailRecipients} disabled={busy}>
              Save recipients
            </button>
          </div>

          <div className="monitor-actions">
            {activeTrackedProducts.length > 0 && <label className="test-product-picker">
              Test alert for
              <select value={testProductId} onChange={event => setTestProductId(event.target.value)}>
                {activeTrackedProducts.map(product =>
                  <option value={product.id} key={product.id}>
                    {product.name || product.product} · {money(product.purchasePrice)}
                  </option>
                )}
              </select>
            </label>}

            <label className="test-product-picker">
              Test recipient (optional)
              <input
                type="email"
                maxLength={254}
                value={testRecipient}
                onChange={event => setTestRecipient(event.target.value)}
                placeholder="Use saved recipients"
              />
            </label>

            <button className="secondary" onClick={testEmail} disabled={busy || !gmailStatus.connected}>
              Send test drop email
            </button>

            <button className="text-button" onClick={runMonitor} disabled={busy}>
              <RefreshCw size={15}/> Run check
            </button>
          </div>
        </section>

        <section className="receipts-section">
          <div className="section-heading">
            <div>
              <h2>Price monitoring</h2>
              <p>Products are checked automatically while their 30-day watch period is active. Expired products remain visible as history.</p>
            </div>
            <div className="searchbox">
              <Search size={16}/>
              <input value={monitorQuery} onChange={event => setMonitorQuery(event.target.value)} placeholder="Search products or retailers…"/>
            </div>
          </div>

          {filteredTrackedProducts.length
            ? <div className="receipt-list">
                {filteredTrackedProducts.map(product =>
                  <TrackedProduct
                    key={`${product.source}-${product.id}`}
                    product={product}
                    onDelete={deleteManualProduct}
                    onDiscover={discoverProduct}
                    onConfirmUrl={confirmProductUrl}
                    onConfirmDate={confirmPurchaseDate}
                    busy={busy}
                  />
                )}
              </div>
            : <Empty
                icon={<Eye size={24}/>}
                title={trackedProducts.length ? 'No matching products' : 'Your price monitor is ready'}
                text={trackedProducts.length ? 'Try another product or retailer search.' : 'There are no products yet. Upload a receipt or add a product with its purchase price.'}
                action={<button className="primary" onClick={() => setShowManual(true)}><Plus size={17}/> Track your first product</button>}
              />}
        </section>
      </>}

      <footer>
        PriceDrop Agent <span>•</span> Local-first receipt storage <span>•</span> Store terms and access limits apply
      </footer>
    </main>

    {showUpload && <div
      className="modal-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) setShowUpload(false);
      }}
    >
      <div className="modal upload-modal">
        <div className="modal-head">
          <div>
            <h2>Upload a receipt</h2>
            <p>Local Gemma extracts the store, purchase date, total, and item prices.</p>
          </div>
          <button className="icon-button" onClick={() => setShowUpload(false)} aria-label="Close upload"><X/></button>
        </div>

        <form onSubmit={submitReceipt}>
          <label>
            Receipt file <span className="required-label">required</span>
            <div className="file-drop">
              <Upload size={22}/>
              <div>
                <b>{file ? file.name : 'Choose a receipt file'}</b>
                <small>Any file format · up to 10 MB · image formats are handled automatically</small>
              </div>
              <input
                type="file"
                required
                accept="*/*"
                onChange={event => setFile(event.target.files?.[0] || null)}
              />
            </div>
          </label>

          <div className="auto-note">
            <ShieldCheck size={17}/>
            <div>
              <b>Local AI: {aiStatus.model}</b>
              <p>{aiStatus.modelAvailable
                ? 'Receipt extraction runs locally through Ollama on this Mac.'
                : aiStatus.connected
                  ? `Ollama is running. Install the selected model with: ollama pull ${aiStatus.model}`
                  : 'Start Ollama locally and install the configured model to enable receipt extraction.'}
                {' '}Product prices are checked from retailer listing data; AI-generated prices are never treated as verified current prices.
              </p>
            </div>
          </div>

          <div className="modal-actions">
            <button type="button" className="secondary" onClick={() => { setShowUpload(false); setFile(null); }}>
              Cancel
            </button>
            <button className="primary" disabled={busy || !file}>
              {busy ? 'Processing receipt…' : 'Upload and extract'}
            </button>
          </div>
        </form>
      </div>
    </div>}

    {showManual && <div
      className="modal-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) setShowManual(false);
      }}
    >
      <div className="modal manual-modal">
        <div className="modal-head">
          <div>
            <h2>Track a product</h2>
            <p>No receipt upload needed. Monitoring uses the purchase date below.</p>
          </div>
          <button className="icon-button" onClick={() => setShowManual(false)} aria-label="Close product form"><X/></button>
        </div>

        <form onSubmit={addManualProduct}>
          <label>
            Product name
            <input
              required
              maxLength={150}
              value={manualProduct.name}
              onChange={event => setManualProduct({ ...manualProduct, name: event.target.value })}
              placeholder="e.g. Organic olive oil, 1 L"
            />
          </label>

          <label>
            Retailer
            <input
              required={!manualProduct.url}
              maxLength={120}
              value={manualProduct.retailer}
              onChange={event => setManualProduct({ ...manualProduct, retailer: event.target.value })}
              placeholder="Required if you do not have a product URL"
            />
          </label>

          <label>
            Brand (optional)
            <input
              maxLength={100}
              value={manualProduct.brand}
              onChange={event => setManualProduct({ ...manualProduct, brand: event.target.value })}
              placeholder="e.g. Ninja"
            />
          </label>

          <label>
            Model / variant (optional)
            <input
              maxLength={100}
              value={manualProduct.model}
              onChange={event => setManualProduct({ ...manualProduct, model: event.target.value })}
              placeholder="Model number, size, or bundle"
            />
          </label>

          <label>
            Purchase price
            <input
              required
              type="number"
              min="0.01"
              step="0.01"
              value={manualProduct.purchasePrice}
              onChange={event => setManualProduct({ ...manualProduct, purchasePrice: event.target.value })}
              placeholder="70.00"
            />
          </label>

          <label>
            Purchase date
            <input
              required
              type="date"
              max={localToday()}
              value={manualProduct.purchaseDate}
              onChange={event => setManualProduct({ ...manualProduct, purchaseDate: event.target.value })}
            />
          </label>

          <label>
            Product URL (optional)
            <input
              type="url"
              value={manualProduct.url}
              onChange={event => setManualProduct({ ...manualProduct, url: event.target.value })}
              placeholder="Leave blank to search the selected retailer"
            />
          </label>

          <label>
            Retailer return/price-adjustment policy URL (optional)
            <input
              type="url"
              value={manualProduct.returnPolicyUrl}
              onChange={event => setManualProduct({ ...manualProduct, returnPolicyUrl: event.target.value })}
              placeholder="Official retailer policy page"
            />
          </label>

          <div className="modal-note">
            <Activity size={16}/>
            <span>Without a URL, the agent searches public search results for the original retailer and verifies the product page. It also checks other retailers for separately labeled offers. Gemma confirms product/variant similarity; search snippets and AI-generated prices are never treated as live prices.</span>
          </div>

          <div className="modal-actions">
            <button type="button" className="secondary" onClick={() => setShowManual(false)}>
              Cancel
            </button>
            <button className="primary" disabled={busy}>
              {busy ? 'Saving product…' : 'Start 30-day watch'}
            </button>
          </div>
        </form>
      </div>
    </div>}
  </div>;
}

function Stat({ title, value, detail, icon, tone }) {
  return <div className="stat-card">
    <div className="stat-top">
      <span>{title}</span>
      <div className={`stat-icon ${tone}`}>{icon}</div>
    </div>
    <strong>{value}</strong>
    <small>{detail}</small>
  </div>;
}

function Empty({ icon, title, text, action }) {
  return <div className="empty">
    <div className="empty-icon">{icon}</div>
    <h3>{title}</h3>
    <p>{text}</p>
    {action}
  </div>;
}

function ReceiptList({ receipts, onDelete }) {
  return <div className="receipt-list">
    {receipts.map(receipt =>
      <article className="receipt-card" key={receipt.id}>
        <div className="receipt-head">
          <div className="merchant-mark">{(receipt.merchant || 'R').slice(0, 1).toUpperCase()}</div>
          <div className="receipt-title">
            <h3>{receipt.merchant}</h3>
            <p>{receipt.fileName || 'Receipt record'} · Purchased {new Date(`${receipt.purchaseDate}T12:00:00`).toLocaleDateString()}</p>
          </div>
          <span className={`status ${receipt.status === 'watch' ? 'watch' : 'off'}`}>
            <i/>{receipt.status === 'watch' ? 'Watch' : 'Not on watch'}
          </span>
          <button className="icon-button delete" title="Delete receipt" onClick={() => onDelete(receipt.id)}>
            <Trash2 size={16}/>
          </button>
        </div>

        <div className="receipt-meta">
          <div><span>Date</span><b>{receipt.purchaseDate}</b></div>
          <div><span>Products</span><b>{(receipt.products || []).length}</b></div>
          <div><span>Watch</span><b>{receipt.status === 'watch' ? 'Yes' : 'No'}</b></div>
        </div>

        {(receipt.products || []).length > 0 && <div className="product-list">
          {receipt.products.map(product => {
            const purchasePrice = Number(product.purchasePrice ?? product.price);

            const currentPrice = product.originalUrlVerified === true &&
              product.currentVerifiedPrice != null &&
              Number.isFinite(Number(product.currentVerifiedPrice))
              ? Number(product.currentVerifiedPrice)
              : null;

            const hasVerifiedDrop = product.monitoringStatus === 'PRICE DROP DETECTED' &&
              currentPrice != null &&
              currentPrice < purchasePrice &&
              Boolean(product.lastCheckedAt);

            return <div className="product-row" key={product.id}>
              <div className="product-dot"><PackageCheck size={16}/></div>

              <div className="product-info">
                <b>{product.product || product.name}</b>
                <small>Purchase date: {product.date || receipt.purchaseDate} · Status: <strong>{product.monitoringStatus || 'URL DISCOVERY'}</strong></small>
                <small>
                  {product.originalUrlVerified && product.url
                    ? <a href={product.url} target="_blank" rel="noreferrer">Verified product page <ExternalLink size={11}/></a>
                    : 'No verified product URL'}
                  {product.lastCheckedAt && ` · Checked ${new Date(product.lastCheckedAt).toLocaleString()}`}
                </small>
                {product.lastError && <small className="error-text">{product.lastError}</small>}
              </div>

              <div className="price-col">
                <span>Price paid</span>
                <b>{money(product.purchasePrice ?? product.price)}</b>
              </div>

              <div className="price-col">
                <span>Verified current</span>
                <b className={hasVerifiedDrop ? 'drop-price' : ''}>{money(currentPrice)}</b>
              </div>

              {hasVerifiedDrop && <span className="drop-badge"><TrendingDown size={13}/> Drop</span>}
            </div>;
          })}
        </div>}
      </article>
    )}
  </div>;
}

function TrackedProduct({
  product,
  onDelete,
  onDiscover,
  onConfirmUrl,
  onConfirmDate,
  busy
}) {
  const [dateDraft, setDateDraft] = useState(product.purchaseDate || product.date || '');

  useEffect(() => {
    setDateDraft(product.purchaseDate || product.date || '');
  }, [product.purchaseDate, product.date]);

  const history = (product.priceHistory || []).filter(snapshot => snapshot.verified !== false);
  const notifications = product.notificationHistory || [];

  const alternativeOffers = (product.alternativeOffers || [])
    .filter(offer => offer.verified === true)
    .sort((left, right) => Number(left.price) - Number(right.price));

  const status = product.monitoringStatus || 'URL DISCOVERY';

  const verifiedCurrentPrice = product.originalUrlVerified === true &&
    product.currentVerifiedPrice != null &&
    Number.isFinite(Number(product.currentVerifiedPrice))
    ? Number(product.currentVerifiedPrice)
    : null;

  const validDrop = status === 'PRICE DROP DETECTED' &&
    verifiedCurrentPrice != null &&
    verifiedCurrentPrice < Number(product.purchasePrice) &&
    Boolean(product.lastCheckedAt);

  const statusClass = validDrop
    ? 'drop'
    : status === 'PRICE UNAVAILABLE' ||
      status === 'NEEDS CONFIRMATION' ||
      status === 'PURCHASE DATE NEEDS CONFIRMATION'
      ? 'unavailable'
      : status === 'WATCH EXPIRED'
        ? 'expired'
        : 'monitoring';

  const formatDateTime = value => value ? new Date(value).toLocaleString() : 'Not checked yet';
  const percent = product.savingsPercent ?? product.priceDropSavingsPercent;

  return <article className="tracked-card">
    <div className="tracked-main">
      {product.imageUrl
        ? <img className="tracked-image" src={product.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer"/>
        : <div className="product-dot"><PackageCheck size={16}/></div>}

      <div className="product-info">
        <b>{product.name || product.product}</b>
        <small>{product.merchant || product.retailer || 'Retailer'} · Purchased {product.purchaseDate || product.date}</small>
        <small>{product.monitoringStartDate || 'Start pending'} through {product.monitoringExpirationDate || 'Expiration pending'} · {status === 'WATCH EXPIRED' ? 'watch period expired' : `${product.daysRemaining} day${product.daysRemaining === 1 ? '' : 's'} remaining`}</small>

        {product.originalUrlVerified && product.url
          ? <small><a href={product.url} target="_blank" rel="noreferrer">Verified original retailer page <ExternalLink size={11}/></a></small>
          : product.url
            ? <small>Submitted URL is not verified: <a href={product.url} target="_blank" rel="noreferrer">Review page <ExternalLink size={11}/></a></small>
            : <small>No verified original retailer URL</small>}

        {product.returnPolicyUrl && <small><a href={product.returnPolicyUrl} target="_blank" rel="noreferrer">Retailer return/price policy <ExternalLink size={11}/></a></small>}
      </div>

      <span className={`monitoring-badge ${statusClass}`}>
        {validDrop ? 'PRICE DROP DETECTED' : status}
      </span>

      <div className="price-col">
        <span>Original purchase</span>
        <b>{money(product.purchasePrice)}</b>
      </div>

      <div className="price-col">
        <span>Verified current</span>
        <b className={validDrop ? 'drop-price' : ''}>{money(verifiedCurrentPrice)}</b>
      </div>

      {validDrop && <span className="drop-badge">
        <TrendingDown size={13}/> Save {money(product.potentialSavings ?? product.priceDropSavings)}
        {percent != null ? ` (${Number(percent).toFixed(1)}%)` : ''}
      </span>}

      {product.source === 'manual' && <button
        className="icon-button delete"
        title="Remove tracked product"
        onClick={() => onDelete(product.id)}
      >
        <Trash2 size={16}/>
      </button>}
    </div>

    <div className="monitor-details">
      <span>Last checked: <b>{formatDateTime(product.lastCheckedAt)}</b></span>
      <span>Next check: <b>{product.nextCheckAt ? formatDateTime(product.nextCheckAt) : 'Not scheduled'}</b></span>
      <span>Previous verified: <b>{money(product.previousVerifiedPrice)}</b></span>
      <span>Lowest verified: <b>{money(product.lowestVerifiedPrice)}</b></span>
      <span>Highest verified: <b>{money(product.highestVerifiedPrice)}</b></span>
      <span>Potential savings: <b>{money(product.potentialSavings)}{percent != null ? ` (${Number(percent).toFixed(1)}%)` : ''}</b></span>
      <span>Notification status: <b>{validDrop ? String(product.notificationStatus || 'not_sent').toUpperCase() : 'NOT SENT'}</b></span>
      <span>Notifications sent: <b>{product.notificationCount || 0}</b></span>
      <span>First drop: <b>{product.firstPriceDropAt ? formatDateTime(product.firstPriceDropAt) : 'None detected'}</b></span>
    </div>

    {product.lastError && <p className="monitor-error">{product.lastError}</p>}

    {status === 'PURCHASE DATE NEEDS CONFIRMATION' && <div className="product-confirmation">
      <label>
        Confirm or correct purchase date
        <input type="date" value={dateDraft} onChange={event => setDateDraft(event.target.value)}/>
      </label>
      <button className="secondary" disabled={busy || !dateDraft} onClick={() => onConfirmDate(product.id, dateDraft)}>
        Confirm date
      </button>
      <span>Monitoring and alerts are paused until you confirm this date.</span>
    </div>}

    {!product.originalUrlVerified && <div className="product-confirmation">
      <button className="secondary" disabled={busy} onClick={() => onDiscover(product.id)}>
        {product.discoveryStatus === 'needs_confirmation' ? 'Search again' : 'Find / verify original retailer URL'}
      </button>
      <span>Only matching original-retailer pages are eligible for price-drop alerts.</span>
    </div>}

    {(product.discoveryCandidates || []).length > 1 && <div className="product-confirmation candidate-list">
      <b>Confirm the matching {product.retailer || 'retailer'} listing</b>

      {product.discoveryCandidates.map(candidate => <div key={candidate.url}>
        <span>{candidate.title}{candidate.priceVerified ? ` · ${money(candidate.price)}` : ' · Current price unavailable'}</span>
        <a href={candidate.url} target="_blank" rel="noreferrer">Review listing <ExternalLink size={11}/></a>
        <button className="secondary" disabled={busy} onClick={() => onConfirmUrl(product.id, candidate.url)}>
          Use this listing
        </button>
      </div>)}
    </div>}

    {history.length > 0 && <div className="price-history">
      <b>Verified price history</b>
      <span>{history.slice(-10).map(snapshot =>
        `${money(snapshot.price)} · ${new Date(snapshot.checkedAt).toLocaleString()}`
      ).join('  →  ')}</span>
    </div>}

    {alternativeOffers.length > 0 && <div className="price-history alternative-history">
      <b>Other retailer offers · verified separately</b>

      {alternativeOffers.slice(0, 5).map(offer => <span key={offer.url}>
        <strong>{offer.retailer}: {money(offer.price)}</strong>
        {product.cheapestAlternative?.url === offer.url && ' · Cheapest verified offer below current tracked-store price'}
        {' · '}Verified {formatDateTime(offer.lastVerifiedAt)}
        {` · Range ${money(offer.lowestVerifiedPrice)}–${money(offer.highestVerifiedPrice)}`}
        {' · '}<a href={offer.url} target="_blank" rel="noreferrer">View alternative <ExternalLink size={11}/></a>
        {offer.priceHistory?.length > 1 && ` · History: ${offer.priceHistory.slice(-5).map(snapshot => money(snapshot.price)).join(' → ')}`}
      </span>)}

      <span>Alternative offers do not affect original-retailer price-drop detection or notifications.</span>
    </div>}

    {!alternativeOffers.length && <div className="price-history alternative-history">
      <b>Other retailer offers</b>
      <span>{product.alternativeDiscoveryStatus === 'searching'
        ? 'Search in progress'
        : product.alternativeDiscoveryStatus === 'no_verified_matches'
          ? 'No exact, verified alternative offers found'
          : product.alternativeDiscoveryStatus === 'unavailable'
            ? 'Public search or product verification is unavailable'
            : 'No verified alternative offers yet'}
        {product.nextAlternativeSearchAt && ` · Next search ${formatDateTime(product.nextAlternativeSearchAt)}`}
      </span>
    </div>}

    {!alternativeOffers.length && product.alternativeDiscoveryError && <p className="monitor-error">
      Alternative search: {product.alternativeDiscoveryError}
    </p>}

    {notifications.length > 0 && <div className="notification-history">
      <b>Email notification history</b>

      {notifications.map((item, index) => <span
        key={`${item.detectedAt}-${index}`}
        className={`notification-event ${item.status}`}
      >
        {item.status.toUpperCase()} · {money(item.price)} · {item.sentAt ? formatDateTime(item.sentAt) : formatDateTime(item.detectedAt)}
        {item.error ? ` · ${item.error}` : ''}
      </span>)}
    </div>}
  </article>;
}

createRoot(document.getElementById('root')).render(<App/>);