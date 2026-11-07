<<<<<<< HEAD
# priceagent
=======
# PriceDrop Agent — Ollama + Gmail Edition

A local React + Express app for tracking product prices from receipt purchases or manual entries. Gemma runs locally through Ollama to extract receipt details; the backend checks retailer listing prices, keeps a price history, and can email a price-drop alert during the 30-day watch window.

## Requirements

- Node.js 20 or newer
- Ollama installed and running locally
- A vision-capable Gemma model pulled in Ollama (default: `gemma4:e4b`)
- A Google OAuth 2.0 Web application for Gmail API sending

## Run locally

1. Extract this ZIP.
2. Open Terminal in the extracted `price-drop-agent-claude-gmail` folder.
3. Install dependencies:

   ```bash
   npm install
   ```

4. Create your local environment file:

   ```bash
   cp .env.example .env
   ```

5. Install and start Ollama, then download the default model:

   ```bash
   ollama pull gemma4:e4b
   ```

   Ollama's API should be available at `http://127.0.0.1:11434`. You can use another locally installed vision-capable model by changing `OLLAMA_MODEL` in `.env`.
6. Copy `.env.example` to `.env` and configure the Google OAuth variables below. Set `ALERT_TO` as an optional initial recipient or manage recipients later in Price monitor.
7. Start the app:

   ```bash
   npm run dev
   ```

8. Open the Vite URL shown in the terminal (normally http://localhost:5173).

Keep `.env` private. Do not paste API keys or email app passwords into chat, screenshots, GitHub, or frontend files.

## Gmail OAuth setup

1. In Google Cloud Console, enable the Gmail API, configure the OAuth consent screen, and create OAuth 2.0 credentials with application type **Web application**. The app requests `gmail.send` and `userinfo.email`; add the Google account as a test user if the consent screen is in Testing mode.
2. Add this exact authorized redirect URI to the OAuth client:
   `http://localhost:4100/api/email/oauth/callback`
3. Add these values to the backend `.env` file:

   ```dotenv
   GOOGLE_CLIENT_ID=your_oauth_client_id
   GOOGLE_CLIENT_SECRET=your_oauth_client_secret
   GOOGLE_REDIRECT_URI=http://localhost:4100/api/email/oauth/callback
   FRONTEND_URL=http://localhost:5173
   ```

4. Restart the backend, open **Price monitor**, and select **Connect Gmail**. Sign in to the Google account that should send alerts and approve the Gmail send permission.
5. Add one or more recipients under **Email notifications** (recipients may use Gmail, Outlook, Yahoo, or another valid provider) and select **Save recipients**.
6. Optionally enter a one-off **Test recipient** (for example, a family member's address), then select **Send test drop email**. The backend verifies Gmail authorization and sends a real test message through the Gmail API.

OAuth client credentials stay in the backend `.env`; the refresh token is stored in the ignored backend-only file `data/google-oauth-tokens.json` with restricted file permissions. Never commit or share either. To reconnect after revocation/expiration, use **Reconnect Gmail**. The app does not use SMTP or Google App Passwords.

Google OAuth apps left in Testing mode may have refresh tokens that expire after seven days for Gmail scopes. For continued use, reconnect when prompted or complete Google's publishing/verification requirements for the app and scopes.

## Local AI and app endpoints

- `GET /api/health` — reports Ollama connection/model status and OAuth configuration (never returns credentials or tokens).
- `GET /api/agent/status` — returns current watch status for products.
- `GET /api/monitor/products` — returns monitored products and expired-watch history, including verified price analytics and notification history.
- `POST /api/monitor/products` — manually add a product using `name`, `purchasePrice`, `purchaseDate` (optional; defaults to today), and either a direct `url` or `retailer` name for public-search discovery. Optional `brand`, `model`, and `returnPolicyUrl` help verify the product match.
- `POST /api/monitor/run` — directly runs a price sweep; price monitoring does not require the local AI model.
- `GET /api/email/oauth/connect` — begins the Google OAuth authorization flow.
- `GET /api/email/oauth/callback` — handles the configured OAuth redirect.
- `GET /api/email/status` — reports Gmail connection status without returning tokens.
- `GET /api/email/settings` and `PUT /api/email/settings` — read/update the local list of alert recipients.
- `POST /api/email/test` — verifies Gmail authorization and sends a clearly labeled test email. Pass `{"productId":"..."}` to simulate a drop for an active tracked product, and/or `{"recipient":"someone@example.com"}` for a one-off destination; this does not change monitoring data.

The backend runs an initial check on startup and then checks eligible products every `MONITOR_INTERVAL_MINUTES` (default 60; minimum 15 minutes). Separately, it searches public DuckDuckGo result pages for an original retailer listing when a URL is missing and for other retailer offers every `ALTERNATIVE_DISCOVERY_INTERVAL_HOURS` (default 24; minimum 6). It runs independently of the dashboard while the backend is running; checks do not overlap. Product monitoring windows, verified observations, discovered URLs/offers, next discovery times, and notification history are persisted alongside the existing receipt and manual-product records, so restarting the backend does not reset them.

## Price-drop email behavior

When a retailer page exposes a verified price below the recorded purchase price and the product is within its 30-day window, the backend automatically sends an email to all configured recipients through the connected Gmail account. The email includes purchase and current prices, dollar and percentage savings, detection time, a product link, remaining days, and a reminder to confirm return/price-adjustment eligibility with the retailer. It does not initiate a return or guarantee a refund.

The app records notification attempts and sent timestamps. A further alert is sent only after a new lower verified price at least $1 and 5% below the last notified price; the same price is not repeatedly emailed. Notification intent is persisted before Gmail is called, and completion is saved immediately after sending. A pending/sending record is not automatically resent after a crash, preventing a duplicate when Gmail may have accepted the original send. Failed sends can retry on a subsequent check.

## Other-retailer offer discovery

The app can use public DuckDuckGo HTML search results to find candidate retailer product pages. It never uses prices or product claims from search snippets. Every candidate URL is checked against public DNS addresses and fetched directly; prices must come from product-specific retailer metadata or a schema.org `Product`/`Offer`. The locally configured Gemma model compares page title, brand, model, and variant evidence; uncertain or conflicting matches are rejected. Verified alternatives and their history are stored separately from the original retailer's price history. They cannot trigger original-retailer alerts. If a valid, recently verified offer from another retailer is below the current verified original-store price, it is shown in a separate dashboard section and may be included in an original-store alert with a clear label.

Public search pages can throttle or block requests, and retailer pages may not expose product-specific price metadata. Those cases are shown as unavailable rather than bypassed or guessed. The app does not evade CAPTCHA, authentication, rate limits, or other access controls.

The dashboard derives status from the original retailer URL and price evidence: **URL DISCOVERY**, **NEEDS CONFIRMATION**, **MONITORING**, **PRICE UNAVAILABLE**, **NO PRICE DROP**, **PRICE DROP DETECTED**, or **WATCH EXPIRED**. A price drop requires a verified original-retailer URL and a current verified USD observation below the purchase price; an alternative retailer's lower price never qualifies.

Products are checked only while they are fewer than 30 calendar days old. At the start of day 30, they leave the active watchlist and are shown as **WATCH EXPIRED** in monitoring history. Their receipt and purchase information are retained rather than deleted. An invalid or future purchase date pauses monitoring and requires user confirmation; the app does not silently substitute the upload date. The 30-day window is app monitoring logic, not a promise that a retailer will approve a return or refund. Check each retailer's actual policy.

Run the isolated, mocked monitoring tests with `npm test`. These tests use injected sample prices and an in-memory email sender; they do not call retailer pages or send real email. A retailer may block automated requests, render prices in JavaScript, or require sign-in; those cases are recorded as **PRICE UNAVAILABLE** and retried at the next scheduled check. The app does not use AI-generated or simulated test prices for monitoring.

## Important limitations

- Price checks use Axios + Cheerio to inspect HTML metadata. Retailers that render prices with JavaScript, require sign-in, block bots, or change their page layout may not be detected. Use official retailer APIs where available and respect each site's terms.
- The receipt picker accepts any file extension up to 10 MB. Images are normalized locally; PDFs are rasterized locally on macOS, and UTF-8 text is read directly. The original upload remains unchanged in `data/uploads/`. Receipt contents are sent only to your local Ollama server, not to an AI cloud API.
- Receipt uploads are optional. In Price monitor, add a product name, purchase price, and direct product URL to start a watch without uploading a receipt.
- When a product URL is missing, public-search discovery attempts to find a page for the original retailer; supplying a direct URL remains the most reliable option. Gemma is used only to compare product identity, never to provide prices or links.
- Price history records successful observations, but a retailer may block automated requests, render prices in JavaScript, require sign-in, or change its page structure. Verify any return eligibility and savings with the retailer.
- This local scheduler runs only while the backend is running and the computer is awake. For always-on monitoring, deploy the backend to a reliable host.
- Receipt AI features require Ollama to be running with the configured model already pulled. Price monitoring and Gmail notifications continue to work independently of the model.

## Backend connection troubleshooting

The local API listens on `127.0.0.1:4100`, and Vite proxies `/api` requests to that same IPv4 address. Start both processes from this project folder with:

```bash
npm run dev
```

The Vite process waits for the backend's lightweight `/api/ready` endpoint before starting, so the first dashboard requests are not sent while Express is still initializing. It fails with a clear timeout message if the backend does not become ready within 60 seconds. Open the frontend at `http://127.0.0.1:5173`. In another terminal, confirm both backend endpoints directly and through Vite's proxy:

```bash
curl -fsS http://127.0.0.1:4100/api/health
curl -fsS http://127.0.0.1:4100/api/monitor/products
curl -fsS http://127.0.0.1:5173/api/health
curl -fsS http://127.0.0.1:5173/api/monitor/products
```

If startup reports that port 4100 is already in use, inspect it with `lsof -nP -iTCP:4100 -sTCP:LISTEN` and stop the app using that port before restarting.
>>>>>>> 92f0dae (Initial PriceDrop Agent application)
