# ShopOS server

Express and the native MongoDB driver. `index.js` contains the API, order and inventory transactions, provider integrations, and the scheduled worker. `api/index.js` is the Vercel handler.

## Run locally

1. Install Node.js 22.13 or later. Use MongoDB Atlas or a MongoDB replica set. The order and inventory code uses transactions.
2. Copy `.env.example` to `.env`. Set `MONGODB_URI` and `MONGODB_DB`, matching the Next.js project. Keep the sample `CLIENT_URL`, `SERVER_URL`, and `PORT` for local development.
3. Run `openssl rand -hex 32` twice. Put the first generated value in `SHOPOS_PROXY_SECRET` on both the server and client. Put the second in `INTEGRATION_ENCRYPTION_KEY` on the server. Generate a separate `BETTER_AUTH_SECRET` for the client.
4. Run `npm ci` and `npm run dev`. Check `http://localhost:8000/health`, then start the client. `npm run check` checks the Express entry point.

Preserve the current database and secrets when upgrading Phase 1. The server creates indexes on first database access. Previously entered duplicate SKUs remain editable, and new or changed SKUs must be unique within their store. For existing SSLCommerz and Stripe checkouts, keep the old project running until any open payment sessions have settled. Then connect the appropriate merchant credentials in each store's settings. Set `ALLOW_PLATFORM_PROVIDER_FALLBACK=true` only if this instance intentionally shares one merchant account, such as a single-merchant development setup.

## Deploy the API

1. Import the server folder as a separate Vercel project, use the **Other** framework preset, and select Node.js 22.x or 24.x. Use the directory containing this README as the root. The included `vercel.json` routes to the Express handler.
2. Add the required environment variables from `.env.example`. Set `SERVER_URL` to the public API origin and `CLIENT_URL` to the public Next.js origin. Keep these origins reachable for payment callbacks. Check `/health` and `/plans` after deployment to confirm routing and the database connection.
3. Generate a separate `CRON_SECRET`. Schedule an HTTP `GET` to `SERVER_URL/jobs/run` with `Authorization: Bearer <CRON_SECRET>` for tracking, courier sync, notifications, and retries. With Vercel Cron, add a `crons` entry in `vercel.json` with `path` `/jobs/run` and a schedule supported by your plan. For local testing set `RUN_LOCAL_JOBS=true`.
4. To open `/admin`, sign in and get the intended account's `id` from the client at `/api/user`. Add that ID to `ADMIN_USER_IDS` and restart the API. `REQUIRE_SELLER_APPROVAL=true` sends new stores to the approval queue. Admins manage pricing, commissions, store access, moderation and tickets.

The plan screen meters uncompressed monthly API responses for shop profiles, product lists and details, landing pages, and product feeds. The counter resets each UTC month. Delivery of images and videos from their external hosts is billed separately by those hosts. CSV import supports up to 500 rows per request. Individual images and compressed ZIP files must be under 3.5 MB each. Folder imports split image files into requests sized for Vercel. Set `IMGBB_API_KEY` for file uploads. Pasted media URLs work without it.

## Connect providers

Connect keys as the store owner under **Dashboard → Settings**. Leave a provider disabled while its credentials, test mode and callback settings are being checked.

| Provider | Setup |
| --- | --- |
| Cash on delivery | Enable for the store and product. Available in the store's domestic market and base currency. The connected local couriers dispatch Bangladesh parcels in BDT. |
| SSLCommerz | Enter the store ID and password. Use `SERVER_URL/payments/sslcommerz/ipn` for IPN. ShopOS sends its success, fail and cancel URLs when it creates a checkout session. Nagad and Rocket can appear through SSLCommerz when the merchant account enables those channels. |
| Stripe per store | Enter the store's secret key and webhook signing secret. Register `SERVER_URL/payments/stripe/webhook/your-shop-slug` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`. |
| Stripe Connect | Set the platform `STRIPE_SECRET_KEY` and `STRIPE_CONNECT_WEBHOOK_SECRET`. Register `SERVER_URL/payments/stripe/webhook` for the same checkout events **from connected accounts**. Complete seller onboarding in Payments. The configured platform commission is collected through Stripe Connect application fees. |
| Stripe Billing | Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and a supported `BILLING_CURRENCY`. Register `SERVER_URL/payments/stripe/webhook` for `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed` **from the platform account**. Configure the Stripe customer portal and retry settings. |
| bKash, aamarPay, shurjoPay, PayPal | Enter the corresponding merchant or developer credentials. The API initiates hosted checkout and verifies the result with the provider. Enable only currencies supported by your account. |
| Steadfast, Pathao, RedX, Shippo | Connect merchant credentials in Shipping providers. Set up delivery zones, the ship-from address, and package dimensions in Store settings. Pathao requires city and zone, RedX requires a delivery area, and Shippo labels use live rates for prepaid parcels. |
| Meta, TikTok, Google | Add IDs and tokens in Integrations. The worker sends events after a visitor opts in. For Google, configure GA4 Measurement Protocol or your compatible server-side endpoint. Add campaign spend in Analytics to calculate ROAS. |
| Email, SMS and WhatsApp | Configure a verified Resend sender for email and an eligible Twilio sender for delivery updates. WhatsApp delivery depends on the approved sender and applicable template rules. |
| Product research | Import observations from CSV, enter them manually, or connect an authorized public HTTPS feed. The research screen includes the CSV headers. The feed should return an array or an object with an `observations` array. |

Live gateway access, courier services, connected Stripe accounts, and messaging each depend on merchant eligibility and credentials. This release uses configured exchange rates, a seller-maintained research feed, and Stripe Connect for automatic settlement. Direct Nagad, Rocket, Wise, Payoneer, Sundarban, eCourier, and Paperfly integrations and optional AI add-ons are outside the included provider set.

### Useful API endpoints

`GET /shops/:slug/feed.xml` provides a Google Merchant Center feed. Outgoing webhooks provide `X-ShopOS-Timestamp` and `X-ShopOS-Signature`. Verify the hexadecimal HMAC-SHA256 of `timestamp.rawBody` using the signing secret shown when creating the webhook. Treat the JSON `id` as a delivery identifier and reject stale timestamps in the receiver.

- [Vercel Functions payload limits](https://vercel.com/docs/functions/limitations)
- [Vercel Cron and authorization](https://vercel.com/docs/schedules/cron-jobs/manage-cron-jobs)
- [SSLCommerz integration documentation](https://developer.sslcommerz.com/doc/v4/)
- [Stripe Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment)
