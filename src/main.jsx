import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, Bell, Clock3, ExternalLink, Eye, PackageCheck, Plus,
  RefreshCw, Search, ShieldCheck, Trash2, TrendingDown, Upload, X
} from 'lucide-react';
import './style.css';
import './monitor.css';
import { mostRecentlyUploadedReceipt, receiptWatchLabel } from './receipt-view.js';
import { monitoringBadgeClass } from './monitor-view.js';

const money = value => value == null || value === ''
  ? '—'
  : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));

const BACKEND_UNAVAILABLE_NOTICE = 'Cannot reach the backend on 127.0.0.1:4100. Retrying automatically…';

const localToday = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const isDateOnly = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const displayPurchaseDate = (value, needsConfirmation = false) =>
  !needsConfirmation && isDateOnly(value) ? value : 'Needs confirmation';

const friendlyError = value => {
  const text = String(value || '');
  if (/\b429\b|rate.?limit/i.test(text)) {
    return 'Receipt saved. AI extraction is temporarily rate limited and will retry automatically.';
  }
  if (/[A-Za-z0-9+/=]{60,}|^\s*[{[]|\n\s+at\s/.test(text)) {
    return 'Something went wrong. The agent will retry automatically.';
  }
  return text;
};

const discoveryLabel = product => {
  if (product.originalUrlVerified && product.url) return 'URL VERIFIED';
  if (product.url) return 'URL SAVED · IDENTITY UNVERIFIED';
  if (product.monitoringStatus === 'PURCHASE DATE NEEDS CONFIRMATION') return 'PAUSED · DATE NEEDED';
  if (product.monitoringStatus === 'OFF WATCH') return 'PAUSED · OFF WATCH';
  if (product.discoveryStatus === 'searching') return 'SEARCHING';
  if (product.discoveryStatus === 'blocked') return 'BLOCKED';
  if (product.discoveryStatus === 'queued') return 'QUEUED';
  return 'AWAITING PRODUCT URL';
};

const receiptStatusLabel = receipt =>
  receiptWatchLabel(receipt);

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
    provider: 'groq',
    model: 'qwen/qwen3.8-27b',
    connected: false,
    modelAvailable: false
  });
  const [page, setPage] = useState('overview');
  const [query, setQuery] = useState('');
  const [monitorQuery, setMonitorQuery] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deletingReceiptId, setDeletingReceiptId] = useState('');
  const latestLoadId = useRef(0);
  const [notice, setNotice] = useState('');
  const [file, setFile] = useState(null);
  const [receiptPurchaseDate, setReceiptPurchaseDate] = useState('');
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
    const loadId = ++latestLoadId.current;
    loadAiStatus(loadId);
    try {
      const [receiptResponse, productResponse] = await Promise.all([
        fetch('/api/receipts'),
        fetch('/api/monitor/products')
      ]);

      const [receiptData, productData] = await Promise.all([
        receiptResponse.json(),
        productResponse.json()
      ]);

      if (!receiptResponse.ok) throw new Error(receiptData.error || 'Could not load receipts.');
      if (!productResponse.ok) throw new Error(productData.error || 'Could not load monitored products.');
      if (loadId !== latestLoadId.current) return false;

      setReceipts(receiptData);
      const products = productData.products || [];
      setTrackedProducts(products);
      setMonitorStats(productData.stats || {
        monitored: 0,
        withVerifiedUrls: 0,
        awaitingUrlDiscovery: 0,
        pricesUnavailable: 0,
        priceDropsDetected: 0
      });

      setNotice(current =>
        current === BACKEND_UNAVAILABLE_NOTICE ? '' : current
      );

      setTestProductId(current =>
        current && products.some(product =>
          product.id === current &&
          product.monitoringStatus === 'ON WATCH'
        )
          ? current
          : products.find(product =>
            product.monitoringStatus === 'ON WATCH'
          )?.id || ''
      );
      return true;
    } catch (error) {
      if (loadId === latestLoadId.current) {
        setNotice(BACKEND_UNAVAILABLE_NOTICE);
      }
      return false;
    }
  }

  async function loadAiStatus(loadId) {
    try {
      const response = await fetch('/api/health');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load AI provider status.');
      if (loadId !== latestLoadId.current) return;
      setAiStatus({
        provider: data.aiProvider || 'groq',
        model: data.aiModel || 'qwen/qwen3.8-27b',
        connected: Boolean(data.aiConnected),
        modelAvailable: Boolean(data.aiModelAvailable),
        error: data.aiError || ''
      });
    } catch (error) {
      if (loadId !== latestLoadId.current) return;
      setAiStatus(current => ({
        ...current,
        connected: false,
        modelAvailable: false,
        error: error.message
      }));
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
      setNotice(friendlyError(error.message));
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

    const timer = setInterval(load, 8000);
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
    product => product.monitoringStatus === 'ON WATCH'
  );

  const activeReceipts = receipts.filter(receipt => receipt.status === 'WATCH');
  const latestReceipt = mostRecentlyUploadedReceipt(receipts);
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
      if (receiptPurchaseDate) formData.append('purchaseDate', receiptPurchaseDate);

      const response = await fetch('/api/receipts/upload', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Upload failed.');

      setShowUpload(false);
      setFile(null);
      setReceiptPurchaseDate('');
      const dashboardRefreshed = await load();
      setNotice(dashboardRefreshed
        ? data.message || 'Receipt uploaded successfully. Dashboard data refreshed.'
        : `${data.message || 'Receipt uploaded successfully.'} The dashboard could not refresh; it will retry automatically.`);
    } catch (error) {
      setNotice(friendlyError(error.message));
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
      setNotice(friendlyError(error.message));
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
      setNotice(friendlyError(error.message));
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
      setNotice(friendlyError(error.message));
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
        method: 'POST',
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
      setNotice(friendlyError(error.message));
    } finally {
      setBusy(false);
    }
  }

  function connectGmail() {
    window.location.assign('/api/email/oauth/connect');
  }

  async function deleteReceipt(id) {
    if (!confirm('Delete this receipt and its monitoring records?')) return;

    setDeletingReceiptId(id);
    try {
      const response = await fetch(`/api/receipts/${id}`, { method: 'DELETE' });
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Could not delete receipt.');

      const deletedReceipt = receipts.find(receipt => receipt.id === id);
      const deletedProductIds = new Set(
        (deletedReceipt?.products || []).map(product => product.id)
      );
      latestLoadId.current++;
      setReceipts(current => current.filter(receipt => receipt.id !== id));
      setTrackedProducts(current => current.filter(product => !deletedProductIds.has(product.id)));

      const dashboardRefreshed = await load();
      setNotice(dashboardRefreshed
        ? data.warning || data.message || 'Receipt and its monitoring records were deleted.'
        : 'Receipt deleted successfully. The dashboard could not refresh; it will retry automatically.');
    } catch (error) {
      setNotice(friendlyError(error.message));
    } finally {
      setDeletingReceiptId('');
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
      setNotice(friendlyError(error.message));
    }
  }

  // FIX: These functions are siblings of deleteManualProduct,
  // not nested inside it. App can now pass them to TrackedProduct.

  async function discoverProduct(id) {
    setBusy(true);
    setNotice('Searching the receipt retailer’s official website and verifying product identity…');

    try {
      const response = await fetch(`/api/monitor/products/${id}/discover`, {
        method: 'POST'
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.error || 'Product discovery failed.');

      await load();
      setNotice(data.message);
    } catch (error) {
      setNotice(friendlyError(error.message));
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
      return true;
    } catch (error) {
      setNotice(friendlyError(error.message));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function confirmPurchaseDate(id, purchaseDate) {
    if (!confirm(`Confirm ${purchaseDate} as the purchase date? Monitoring and email alerts will use this date.`)) return false;

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
      return true;
    } catch (error) {
      setNotice(friendlyError(error.message));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveReceiptDate(id, purchaseDate) {
    setBusy(true);
    try {
      const response = await fetch(`/api/receipts/${id}/confirm-date`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purchaseDate })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save purchase date.');
      await load();
      setNotice(data.message);
      return true;
    } catch (error) {
      setNotice(friendlyError(error.message));
      return false;
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
          <Stat title="Products monitored" value={monitorStats.monitored} detail="Eligible products, including those awaiting their first check" icon={<Activity size={18}/>} tone="purple"/>
          <Stat title="Verified product URLs" value={monitorStats.withVerifiedUrls} detail="Official retailer pages" icon={<ShieldCheck size={18}/>} tone="green"/>
          <Stat title="Prices unavailable" value={monitorStats.pricesUnavailable} detail="Live price not verified" icon={<Clock3 size={18}/>} tone="orange"/>
          <Stat title="Price drops detected" value={drops} detail="Retailer prices; product identity may be unverified" icon={<Bell size={18}/>} tone="orange"/>
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
            <div><h2>Latest receipt</h2><p>Earlier uploads remain in your receipt portal.</p></div>
            <button className="secondary" onClick={() => setPage('monitor')}>Open price monitor</button>
          </div>

          {receipts.length
            ? <ReceiptList receipts={latestReceipt ? [latestReceipt] : []} onDelete={deleteReceipt} deletingReceiptId={deletingReceiptId} onSaveDate={saveReceiptDate} busy={busy}/>
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
          ? <ReceiptList receipts={filteredReceipts} onDelete={deleteReceipt} deletingReceiptId={deletingReceiptId} onSaveDate={saveReceiptDate} busy={busy}/>
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
            <p>Groq extracts the retailer, purchase date, and item details. A rate limit does not discard your receipt. New uploads are added to your receipt history; deleting a receipt removes its monitoring records.</p>
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

          <label>
            Purchase date <span>(optional)</span>
            <input
              type="date"
              max={localToday()}
              value={receiptPurchaseDate}
              onChange={event => setReceiptPurchaseDate(event.target.value)}
            />
            <small>Enter the date printed on the receipt. If provided, it takes precedence over the extracted date.</small>
          </label>

          <div className="auto-note">
            <ShieldCheck size={17}/>
            <div>
              <b>Groq: {aiStatus.model}</b>
              <p>{aiStatus.modelAvailable
                ? 'Groq extracts receipt details and compares product identity. Live prices always come from retailer pages.'
                : aiStatus.connected
                  ? `Groq is connected, but the selected model (${aiStatus.model}) is unavailable.`
                  : 'Configure GROQ_API_KEY to enable receipt extraction and product identity comparison.'}
                {' '}Product prices are checked from retailer listing data; AI-generated prices are never treated as verified current prices.
              </p>
            </div>
          </div>

          <div className="modal-actions">
            <button type="button" className="secondary" onClick={() => { setShowUpload(false); setFile(null); setReceiptPurchaseDate(''); }}>
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
            <span>Without a URL, the agent searches only the original retailer’s official website. Other retailers, if shown, are separate alternatives and never set the original price. Groq compares product identity; live prices come from retailer pages.</span>
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

function ReceiptDatePrompt({ receipt, onSaveDate, busy }) {
  const [date, setDate] = useState('');
  return <div className="product-confirmation">
    <label>
      Purchase date on receipt
      <input type="date" max={localToday()} value={date} onChange={event => setDate(event.target.value)}/>
    </label>
    <button className="secondary" disabled={busy || !date} onClick={() => onSaveDate(receipt.id, date)}>
      Save purchase date
    </button>
    <span>The date could not be read clearly. Enter it to determine whether this purchase is on watch.</span>
  </div>;
}

function ReceiptList({ receipts, onDelete, deletingReceiptId, onSaveDate, busy }) {
  return <div className="receipt-list">
    {receipts.map(receipt =>
      <article className="receipt-card" key={receipt.id}>
        <div className="receipt-head">
          <div className="merchant-mark">{(receipt.merchant || 'R').slice(0, 1).toUpperCase()}</div>
          <div className="receipt-title">
            <h3>{receipt.merchant}</h3>
            <p>{receipt.fileName || 'Receipt record'} · Purchased {displayPurchaseDate(receipt.purchaseDate, receipt.purchaseDateNeedsConfirmation)}</p>
          </div>
          <span className={`status ${receipt.status === 'WATCH' ? 'watch' : 'off'}`}>
            <i/>{receiptStatusLabel(receipt)}
          </span>
          <button
            className="icon-button delete"
            title={deletingReceiptId === receipt.id ? 'Deleting receipt' : 'Delete receipt'}
            aria-label={deletingReceiptId === receipt.id ? 'Deleting receipt' : 'Delete receipt'}
            disabled={deletingReceiptId === receipt.id}
            onClick={() => onDelete(receipt.id)}
          >
            <Trash2 size={16}/>
          </button>
        </div>

        <div className="receipt-meta">
          <div><span>Date</span><b>{displayPurchaseDate(receipt.purchaseDate, receipt.purchaseDateNeedsConfirmation)}</b></div>
          <div><span>Products</span><b>{(receipt.products || []).length}</b></div>
          <div><span>Watch</span><b>{receipt.status === 'WATCH' ? 'Yes' : receiptStatusLabel(receipt)}</b></div>
        </div>

        {receipt.extractionMessage && <p className="pending-text">{friendlyError(receipt.extractionMessage)}</p>}

        {receipt.extractionStatus === 'complete' && receipt.purchaseDateNeedsConfirmation &&
          <ReceiptDatePrompt receipt={receipt} onSaveDate={onSaveDate} busy={busy}/>}

        {(receipt.products || []).length > 0 && <div className="product-list">
          {receipt.products.map(product => {
            const purchasePrice = Number(product.purchasePrice ?? product.price);

            const currentPrice = product.currentVerifiedPrice != null &&
              Number.isFinite(Number(product.currentVerifiedPrice))
              ? Number(product.currentVerifiedPrice)
              : null;

            const hasVerifiedDrop = product.priceStatus === 'PRICE DROP DETECTED' &&
              currentPrice != null &&
              currentPrice < purchasePrice &&
              Boolean(product.lastCheckedAt);

            return <div className="product-row" key={product.id}>
              <div className="product-dot"><PackageCheck size={16}/></div>

              <div className="product-info">
                <b>{product.product || product.name}</b>
                <small>Purchase date: {displayPurchaseDate(product.date || receipt.purchaseDate, product.purchaseDateNeedsConfirmation)} · Watch: <strong>{product.monitoringStatus}</strong> · Product URL: <strong>{discoveryLabel(product)}</strong></small>
                {product.purchaseDateNeedsConfirmation && (
                  <small className="pending-text">Enter the purchase date above to start product discovery and price monitoring if the purchase is on watch.</small>
                )}
                <small>
                  {product.originalUrlVerified && product.url
                    ? <a href={product.url} target="_blank" rel="noreferrer">Verified product page <ExternalLink size={11}/></a>
                    : product.url
                      ? <a href={product.url} target="_blank" rel="noreferrer">Product link saved · identity unverified <ExternalLink size={11}/></a>
                    : 'No verified product URL'}
                  {product.lastCheckedAt && ` · Checked ${new Date(product.lastCheckedAt).toLocaleString()}`}
                </small>
                {product.monitoringStatus === 'ON WATCH' && !product.originalUrlVerified && product.discoveryStatus === 'searching' && (
                  <small>Searching {receipt.merchant || product.retailer || 'the retailer'} for the product page automatically…</small>
                )}
                {product.monitoringStatus === 'ON WATCH' && !product.originalUrlVerified && product.discoveryStatus === 'queued' && (
                  <small>Product-page search is queued for {receipt.merchant || product.retailer || 'the retailer'}.</small>
                )}
                {product.monitoringStatus === 'ON WATCH' && !product.url && !product.originalUrlVerified && ['awaiting_url', 'blocked'].includes(product.discoveryStatus) && (
                  <small>No product page found yet. {product.nextProductDiscoveryAt
                    ? `Next search: ${new Date(product.nextProductDiscoveryAt).toLocaleString()}.`
                    : 'The agent will retry automatically.'} You can also add the URL in Price monitor.</small>
                )}
                {product.lastError && <small className="error-text">{friendlyError(product.lastError)}</small>}
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
  const initialDate = product.purchaseDate || product.date || '';
  const [dateDraft, setDateDraft] = useState(isDateOnly(initialDate) ? initialDate : '');
  const [dateEditorOpen, setDateEditorOpen] = useState(
    product.monitoringStatus === 'PURCHASE DATE NEEDS CONFIRMATION'
  );
  const [urlDraft, setUrlDraft] = useState(product.url || '');
  const [urlEditorOpen, setUrlEditorOpen] = useState(false);

  useEffect(() => {
    const value = product.purchaseDate || product.date || '';
    setDateDraft(isDateOnly(value) ? value : '');
  }, [product.purchaseDate, product.date]);

  useEffect(() => {
    if (product.monitoringStatus === 'PURCHASE DATE NEEDS CONFIRMATION') {
      setDateEditorOpen(true);
    }
  }, [product.monitoringStatus]);

  useEffect(() => {
    setUrlDraft(product.url || '');
  }, [product.url]);

  const history = (product.priceHistory || []).filter(snapshot => snapshot.verified !== false);
  const notifications = product.notificationHistory || [];

  const alternativeOffers = (product.alternativeOffers || [])
    .filter(offer => offer.verified === true)
    .sort((left, right) => Number(left.price) - Number(right.price));

  const status = product.monitoringStatus || 'PURCHASE DATE NEEDS CONFIRMATION';
  const priceStatus = product.priceStatus;

  const verifiedCurrentPrice = product.currentVerifiedPrice != null &&
    Number.isFinite(Number(product.currentVerifiedPrice))
    ? Number(product.currentVerifiedPrice)
    : null;

  const validDrop = status === 'ON WATCH' && priceStatus === 'PRICE DROP DETECTED' &&
    verifiedCurrentPrice != null &&
    verifiedCurrentPrice < Number(product.purchasePrice) &&
    Boolean(product.lastCheckedAt);

  const statusClass = monitoringBadgeClass({
    status,
    priceStatus,
    url: product.url,
    validDrop
  });

  const formatDateTime = value => value ? new Date(value).toLocaleString() : 'Not checked yet';
  const percent = product.savingsPercent ?? product.priceDropSavingsPercent;

  return <article className="tracked-card">
    <div className="tracked-main">
      {product.imageUrl
        ? <img className="tracked-image" src={product.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer"/>
        : <div className="product-dot"><PackageCheck size={16}/></div>}

      <div className="product-info">
        <b>{product.name || product.product}</b>
        <small>{product.merchant || product.retailer || 'Retailer'} · Purchased {displayPurchaseDate(product.purchaseDate || product.date, status === 'PURCHASE DATE NEEDS CONFIRMATION')}</small>
        <small>{product.monitoringStartDate || 'Start pending'} through {product.monitoringExpirationDate || 'Expiration pending'} · {status === 'OFF WATCH' ? 'watch period expired' : `${product.daysRemaining} day${product.daysRemaining === 1 ? '' : 's'} remaining`}</small>
        <small>Product URL: <strong>{product.originalUrlVerified && product.url ? 'VERIFIED' : discoveryLabel(product)}</strong></small>
        {status === 'ON WATCH' && priceStatus === 'PRICE UNAVAILABLE' && <small>Price status: unavailable</small>}

        {product.originalUrlVerified && product.url
          ? <small><a href={product.url} target="_blank" rel="noreferrer">URL VERIFIED · Original retailer page <ExternalLink size={11}/></a></small>
          : product.url
            ? <small><a href={product.url} target="_blank" rel="noreferrer">URL SAVED · Product identity unverified <ExternalLink size={11}/></a></small>
            : <small>No verified original retailer URL</small>}

        {status === 'ON WATCH' && !product.originalUrlVerified && product.discoveryStatus === 'searching' && (
          <small>SEARCHING FOR PRODUCT URL · Searching the {product.merchant || product.retailer || 'retailer'} website automatically.</small>
        )}
        {status === 'ON WATCH' && !product.originalUrlVerified && product.discoveryStatus === 'queued' && (
          <small>Product-page search is queued for {product.merchant || product.retailer || 'the retailer'}.</small>
        )}

        {product.returnPolicyUrl && <small><a href={product.returnPolicyUrl} target="_blank" rel="noreferrer">Retailer return/price policy <ExternalLink size={11}/></a></small>}
      </div>

      <span className={`monitoring-badge ${statusClass}`}>
        {status}
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
      {product.currentPriceSource === 'Costco warehouse price' && <span>Price source: <b>Costco warehouse price · may vary by location</b></span>}
      <span>Next check: <b>{product.nextCheckAt ? formatDateTime(product.nextCheckAt) : 'Not scheduled'}</b></span>
      <span>Previous verified: <b>{money(product.previousVerifiedPrice)}</b></span>
      <span>Lowest verified: <b>{money(product.lowestVerifiedPrice)}</b></span>
      <span>Highest verified: <b>{money(product.highestVerifiedPrice)}</b></span>
      <span>Potential savings: <b>{money(product.potentialSavings)}{percent != null ? ` (${Number(percent).toFixed(1)}%)` : ''}</b></span>
      <span>Notification status: <b>{validDrop ? String(product.notificationStatus || 'not_sent').toUpperCase() : 'NOT SENT'}</b></span>
      <span>Notifications sent: <b>{product.notificationCount || 0}</b></span>
      <span>First drop: <b>{product.firstPriceDropAt ? formatDateTime(product.firstPriceDropAt) : 'None detected'}</b></span>
    </div>

    {product.lastError && product.monitoringStatus !== 'AWAITING PRODUCT URL' && (
      <p className="monitor-error">{friendlyError(product.lastError)}</p>
    )}

    {product.discoveryMessage && status === 'ON WATCH' && !product.originalUrlVerified && !product.url && (
      <p className="pending-text">{product.discoveryMessage}</p>
    )}

    {!dateEditorOpen && <button className="secondary" onClick={() => setDateEditorOpen(true)}>
      {status === 'PURCHASE DATE NEEDS CONFIRMATION' ? 'Confirm purchase date' : 'Correct purchase date'}
    </button>}

    {dateEditorOpen && <div className="product-confirmation">
      <label>
        {status === 'PURCHASE DATE NEEDS CONFIRMATION' ? 'Confirm purchase date' : 'Correct purchase date'}
        <input type="date" max={localToday()} value={dateDraft} onChange={event => setDateDraft(event.target.value)}/>
      </label>
      <button
        className="secondary"
        disabled={busy || !dateDraft}
        onClick={async () => {
          if (await onConfirmDate(product.id, dateDraft)) setDateEditorOpen(false);
        }}
      >
        Save date
      </button>
      {status === 'PURCHASE DATE NEEDS CONFIRMATION' && (
        <span>Monitoring and alerts are paused until you confirm this date.</span>
      )}
    </div>}

    {product.url && !urlEditorOpen && (
      <button className="secondary" onClick={() => setUrlEditorOpen(true)}>Edit URL</button>
    )}

    {(!product.url || urlEditorOpen) && (
      <div className="product-confirmation">
        <label>
          Product URL
          <input
            type="url"
            value={urlDraft}
            onChange={event => setUrlDraft(event.target.value)}
            placeholder="https://retailer.example/product-page"
          />
        </label>

        <div className="confirmation-actions">
          {!product.originalUrlVerified && <button
            className="secondary"
            disabled={busy || status !== 'ON WATCH'}
            onClick={() => onDiscover(product.id)}
          >
            {product.discoveryStatus === 'needs_confirmation'
              ? 'Search again'
              : 'Let agent search again'}
          </button>}

          <button
            className="primary"
            disabled={busy || !urlDraft.trim()}
            onClick={async () => {
              if (await onConfirmUrl(product.id, urlDraft.trim())) setUrlEditorOpen(false);
            }}
          >
            Save product URL
          </button>
          {product.url && <button className="secondary" onClick={() => setUrlEditorOpen(false)}>Cancel</button>}
        </div>

        <span>
          The link must belong to the original retailer. Product identity may remain unverified.
        </span>
      </div>
    )}

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
      <b>Price-drop notifications</b>

      {notifications.map((item, index) => <span
        key={`${item.detectedAt}-${index}`}
        className={`notification-event ${item.status}`}
      >
        {item.productName || product.name} · {item.retailer || product.retailer || product.merchant} · Purchased {money(item.purchasePrice ?? product.purchasePrice)} · Current {money(item.price)} · Save {money(item.savings)} ({Number(item.savingsPercent || 0).toFixed(1)}%) · Checked {formatDateTime(item.detectedAt)} · Email {item.status.toUpperCase()}{item.productIdentityVerified === false ? ' · Product identity unverified' : ''}{item.priceSource === 'Costco warehouse price' ? ' · Warehouse price may vary by location' : ''}
        {' · '}{item.url && <a href={item.url} target="_blank" rel="noreferrer">Product link <ExternalLink size={11}/></a>}
        {item.error ? ` · ${item.error}` : ''}
      </span>)}
    </div>}
  </article>;
}

createRoot(document.getElementById('root')).render(<App/>);
