# PriceDrop Agent — Groq + Gmail

A React + Express app for tracking receipt purchases and monitoring live prices on the original retailer's official website. Groq extracts receipt details and compares product identity; the backend reads live prices directly from retailer pages and Gmail can notify multiple recipients about verified drops.

## Requirements

- Node.js 20.16 or newer (or a current Node.js LTS release)
- A Groq API key and a supported Groq model
- A Google OAuth 2.0 Web application for Gmail API sending

## Run locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your local environment file (macOS/Linux):

   ```bash
   cp .env.example .env
   ```

   On Windows PowerShell, use `Copy-Item .env.example .env` instead.

3. Configure `GROQ_API_KEY` and the Google OAuth settings in `.env`. Alternatively, export `GROQ_API_KEY` in your shell; an `.env` file is optional. Set `ALERT_TO` as an optional initial recipient or manage multiple recipients later in Price monitor. The backend uses `qwen/qwen3.8-27b` and the Groq SDK's default endpoint; legacy `GROQ_URL` settings are ignored.
4. Start the app:

   ```bash
   npm run dev
   ```

5. Open the Vite URL shown in the terminal (normally http://localhost:5173).

To start only the backend, run `npm run server` from the project root. It listens on http://127.0.0.1:4100 by default; no `source .env` command is needed.

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

The backend runs an initial check on startup and schedules checks every `PRICE_CHECK_INTERVAL_HOURS` (default and minimum 24 hours). Each product is checked at most once per local calendar day, including manual checks and after restarts; a manual check on a new day may run before 24 hours have elapsed. Original product discovery is separately scheduled using `PUBLIC_PRODUCT_DISCOVERY_INTERVAL_HOURS` (default 24 hours); persisted next-attempt times prevent early retries after restart. A manual **Run check** or individual discovery request can search immediately and resets that product's next scheduled discovery time. Retailer domains are resolved from each receipt's merchant, and product searches are restricted to that official domain. Verified URLs are saved automatically and may be edited later. Discovery only runs for purchases within the 30-day watch window with a clear or user-confirmed date. An unclear or missing date pauses discovery until confirmed; expired purchases are off watch and are not searched. The dashboard shows product URL discovery separately from the purchase-date status: **ON WATCH**, **OFF WATCH**, or **PURCHASE DATE NEEDS CONFIRMATION**. Price monitoring and alerts run only while on watch; price outcomes are exposed separately as `priceStatus`. A detected drop is saved in the dashboard before Gmail is attempted; a failed email is recorded without removing the notification. Each product/price pair generates at most one email attempt. Searches are processed individually and candidates are stored before verification. Costco searches that are blocked or return no results are reported as blocked; the user can paste a URL. Separate alternative-retailer offers remain clearly distinct from original-retailer prices. Product windows, verified observations, discovered URLs, and notification history are persisted locally.

Costco product URLs do not have to follow a particular path format. The app still checks the official domain, product-page evidence, and product identity before marking a link verified. A saved official-retailer link whose identity is unverified can be checked starting on the next local calendar day, as long as the product is on watch and has a valid purchase price. Such links are labeled as identity-unverified in the dashboard and alerts; the retailer still must provide a verifiable price. Verification and price checks can fail if the retailer blocks access.

Discovery automatically saves the first eligible official-retailer result, even if product identity cannot be verified, and stops searching after saving it. The saved link can be edited. A first result may be a different item, so check the link before relying on its price or alerts.

When a Costco product page exposes an unambiguous dollar amount labeled **Warehouse Price**, it can be compared with the receipt purchase price. Warehouse prices may vary by location and differ from online prices; the dashboard and alerts identify this price source. Ambiguous amounts, unit prices, and discounts are not treated as warehouse prices.

The dashboard displays the latest uploaded receipt; earlier receipts remain in the receipt portal and contribute to the totals. Receipts outside the 30-day window show **OFF WATCH**. If the printed date cannot be read, the date must be confirmed in Price monitor rather than inferred from the upload date. The products-monitored total counts products eligible for the watch window, including products awaiting their first price check.

The receipt upload form also accepts an optional purchase date. When supplied, it overrides the extracted date and is saved as user-confirmed; otherwise the app uses the date read from the receipt. If the date is unclear, the receipt card asks for it and updates the watch status after it is saved. Future and invalid dates are rejected.

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
- The receipt picker accepts files up to 10 MB. JPG, JPEG, PNG, and WebP images are normalized locally; HEIC and HEIF are converted server-side to JPEG before normalization and stored as JPEG while preserving the original filename in receipt metadata. PDFs of up to three pages are rasterized on Windows, macOS, or Linux, and UTF-8 text is read directly. Swift is not required. Receipt images/text are sent to Groq for extraction. Provider health uses a real request and is cached for one minute. HTTP 429 errors are retried during extraction; if retries are exhausted, the receipt is saved as `EXTRACTION FAILED`, as with other provider failures. Errors are logged with the receipt ID, operation, HTTP status, message, and response body.
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
