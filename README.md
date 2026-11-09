# PriceDrop Agent — Groq + Gmail

A React + Express app for tracking receipt purchases and monitoring live prices on the original retailer's official website. Groq extracts receipt details and compares product identity; the backend reads live prices directly from retailer pages and Gmail can notify multiple recipients about verified drops.

## Requirements

- Node.js 20 or newer
- A Groq API key and a supported Groq model
- A Google OAuth 2.0 Web application for Gmail API sending

## Run locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your local environment file:

   ```bash
   cp .env.example .env
   ```

3. Configure `GROQ_API_KEY`, `GROQ_MODEL`, and the Google OAuth settings in `.env`. Set `ALERT_TO` as an optional initial recipient or manage multiple recipients later in Price monitor.
4. Start the app:

   ```bash
   npm run dev
   ```

5. Open the Vite URL shown in the terminal (normally http://localhost:5173).

On the first development startup, the predev step installs Playwright Chromium if it is not already available. The backend uses Playwright directly because Copilot-hosted MCP tools are not available to the standalone Node.js process; product discovery and price checks therefore run without requiring Copilot to remain open.

Each successful receipt upload is added to the existing receipt history. Deleting a receipt removes its products and uploaded file without removing other receipts or manually tracked products.

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

## Groq and app endpoints

- `GET /api/health` — reports Groq connection/model status and OAuth configuration (never returns credentials or tokens).
- `POST /api/receipts/upload` — uploads and extracts a receipt. `/api/receipts` remains available for compatibility.
- `GET /api/receipts` — lists saved receipts.
- `GET /api/agent/status` — returns current watch status for products.
- `GET /api/monitor/products` — returns monitored products and expired-watch history, including verified price analytics and notification history.
- `POST /api/monitor/products` — manually add a product using `name`, `purchasePrice`, `purchaseDate` (optional; defaults to today), and either a direct `url` or retailer name for official-site discovery.
- `POST /api/monitor/products/:id/discover` — searches the merchant's official website for a product page.
- `POST /api/monitor/products/:id/confirm-url` — saves and verifies a manually entered URL against the receipt retailer.
- `POST /api/monitor/products/:id/confirm-date` — records a user-confirmed date in `YYYY-MM-DD` form.
- `POST /api/monitor/run` — directly runs an independent price sweep.
- `GET /api/email/oauth/connect` — begins the Google OAuth authorization flow.
- `GET /api/email/oauth/callback` — handles the configured OAuth redirect.
- `GET /api/email/status` — reports Gmail connection status without returning tokens.
- `GET /api/email/settings` and `POST /api/email/settings` — read/update the persistent list of alert recipients (`PUT` remains supported).
- `POST /api/email/test` — verifies Gmail authorization and sends a clearly labeled test email. Pass `{"productId":"..."}` to simulate a drop for an active tracked product, and/or `{"recipient":"someone@example.com"}` for a one-off destination; this does not change monitoring data.

The backend runs an initial check on startup and then checks eligible products every `MONITOR_INTERVAL_MINUTES` (default 60; minimum 15 minutes). Retailer domains are resolved from each receipt's merchant, and product searches are restricted to that official domain. Discovery can run while a purchase date needs confirmation, but price monitoring and alerts remain paused. Searches are queued and processed individually; unsuccessful searches are retried when due, including after a restart. If discovery is unsuccessful, the receipt and product remain saved as **AWAITING PRODUCT URL**; the user can paste a URL and the backend retries verification. Separate alternative-retailer offers remain clearly distinct from original-retailer prices. Product windows, verified observations, discovered URLs, and notification history are persisted locally.

## Price-drop email behavior

When a retailer page exposes a verified price below the recorded purchase price and the product is within its 30-day window, the backend automatically sends an email to all configured recipients through the connected Gmail account. The email includes purchase and current prices, dollar and percentage savings, detection time, a product link, remaining days, and a reminder to confirm return/price-adjustment eligibility with the retailer. It does not initiate a return or guarantee a refund.

The app records notification attempts and sent timestamps. A verified current price below the purchase price triggers a deterministic drop; the same unchanged price is not repeatedly emailed, while a different lower price can trigger another alert. Notification intent is persisted before Gmail is called, and completion is saved immediately after sending. Failed sends can retry on a subsequent check.

## Other-retailer offer discovery

The agent identifies the official retailer domain from the receipt merchant, searches that retailer's website in a Playwright browser, opens likely product pages, and compares product details with the receipt. Search results come from product cards or product structured data; navigation pages are rejected. Costco searches wait for results and handle cookie prompts, then fall back to a public search restricted to Costco.com if no products appear. Groq is used only when a plausible product requires identity comparison; it never supplies URLs or live prices. Current prices are read from product-specific retailer page data or an unambiguous displayed price, then fetched again in the browser on scheduled checks. Candidate pages from competitors cannot become the original product URL.

Public search pages can throttle or block requests, and retailer pages may not expose product-specific price metadata. Those cases are shown as unavailable rather than bypassed or guessed. The app does not evade CAPTCHA, authentication, rate limits, or other access controls.

Product statuses include **WATCH**, **MONITORING**, **SEARCHING FOR PRODUCT URL**, **AWAITING PRODUCT URL**, **PURCHASE DATE NEEDS CONFIRMATION**, **PRICE UNAVAILABLE**, **PRICE DROP DETECTED**, and **WATCH EXPIRED**. For the app's known US retailer sites, numeric printed dates use US month/day/year order; dates from unknown merchants remain unconfirmed if their order is ambiguous. Saved receipts with a missing date are re-evaluated from their printed date evidence, without replacing an existing or user-confirmed date. Missing or invalid dates are never replaced with the upload date. Dates are stored as `YYYY-MM-DD` and all watch-window calculations use date-only arithmetic. A price drop requires a verified original-retailer URL and current price below the purchase price.

Products are checked only while they are fewer than 30 calendar days old. At the start of day 30, they leave the active watchlist and are shown as **WATCH EXPIRED** in monitoring history. Their receipt and purchase information are retained rather than deleted. An invalid or future purchase date pauses monitoring and requires user confirmation; the app does not silently substitute the upload date. The 30-day window is app monitoring logic, not a promise that a retailer will approve a return or refund. Check each retailer's actual policy.

Run the isolated, mocked monitoring tests with `npm test`. These tests use injected sample prices and an in-memory email sender; they do not call retailer pages or send real email. A retailer may block automated requests, render prices in JavaScript, or require sign-in; those cases are recorded as **PRICE UNAVAILABLE** and retried at the next scheduled check. The app does not use AI-generated or simulated test prices for monitoring.

## Important limitations

- Product discovery and price checks use Playwright Chromium from the backend. Retailers that require sign-in, block automation, or change their search or page layout may not be detected. Use official retailer APIs where available and respect each site's terms.
- The receipt picker accepts any file extension up to 10 MB. Images are normalized locally; PDFs are rasterized locally on macOS, and UTF-8 text is read directly. Receipt images/text are sent to Groq for extraction. If Groq returns HTTP 429, the original receipt is retained and extraction is retried later.
- Receipt uploads are optional. In Price monitor, add a product name, purchase price, and direct product URL to start a watch without uploading a receipt.
- When a product URL is missing, discovery is restricted to the official website of the original retailer. A submitted URL is checked against that retailer before monitoring.
- Price history records successful observations, but a retailer may block automated requests, render prices in JavaScript, require sign-in, or change its page structure. Verify any return eligibility and savings with the retailer.
- This local scheduler runs only while the backend is running and the computer is awake. For always-on monitoring, deploy the backend to a reliable host.
- Groq is used only for receipt extraction and product identity comparison, not for scheduled price checks. Price monitoring and Gmail notifications continue if extraction or discovery is temporarily rate limited.

## Backend connection troubleshooting

The local API listens on `127.0.0.1:4100`, and Vite proxies `/api` requests to that same IPv4 address. Start both processes from this project folder with:

```bash
npm run dev
```

The dev launcher reuses an already-running PriceDrop API on the configured backend port, or starts one when needed. It then starts Vite, which waits for the backend's lightweight `/api/ready` endpoint before serving the app. This lets `npm run dev` work even if the API was started separately. If port 5173 is occupied, Vite automatically selects another available port and prints its URL. In another terminal, confirm backend endpoints directly and through Vite's proxy:

```bash
curl -fsS http://127.0.0.1:4100/api/health
curl -fsS http://127.0.0.1:4100/api/monitor/products
curl -fsS http://127.0.0.1:5173/api/health
curl -fsS http://127.0.0.1:5173/api/monitor/products
```

If port 4100 is occupied by a different service, set `PORT` to an available port; the dev launcher and Vite proxy use the same value.
