# Deriv Bot Scanner 3.2

This version fixes the "0 bots" problem caused by looking only for direct XML URLs.

It now:
- renders public pages with Playwright;
- scrolls pages to trigger lazy-loaded catalogs;
- inspects visible bot/catalog cards and buttons;
- inspects iframe pages;
- monitors public XHR/fetch responses;
- inspects JSON/HTML/JS responses for XML/download URLs;
- retains catalog entries even when a direct XML file URL is not exposed;
- labels entries as XML or Catalog;
- marks direct public XML links as downloadable.

For a catalog such as a public bot-store page, seeing the bot name is possible even when the actual download URL is only revealed after a permitted user action.

Render:
Build Command: `npm install`
Start Command: `node server.js`
Environment variable: `PLAYWRIGHT_BROWSERS_PATH=0`

This does not bypass authentication, CAPTCHA, Cloudflare challenges, paywalls, or private/protected APIs.
