# Hosted brand-preview API

Live at **https://launch-video-kit-preview.subasiarhan3.workers.dev/** (`/api/preview`).

A Cloudflare Worker: `POST /api/preview {url}` opens the reader's site in a real,
server-side headless Chrome (Cloudflare Browser Rendering) and returns a brand kit
(colours, fonts, name, tagline) plus a live screenshot, usually in 5-15s and always under
the ~60s budget. `public/index.html` is the landing page: a URL box, the live preview, and
"Use this template" / repo CTAs once it is done.

This is a hosted, scoped-down port of `../tools/brand-from-url.mjs` - see the header comment
in `extract.ts` for exactly what is ported verbatim (the DOM-walk and colour-role maths) and
what is deliberately left out of this fast path (font and logo *files*; the local tool stays
the canonical, complete extraction once you're actually building a film).

## Files

| File | What it is |
|---|---|
| `index.ts` | The Worker: `POST /api/preview`, an SSRF guard on the submitted URL, the browser session, the timeout budget. |
| `extract.ts` | The ported extraction: `extractInPage` (in-browser DOM walk), `histogramFromDataUri` (pixel sampling of the screenshot already taken, no second page), `decideBrand` (the colour-role decision engine). |
| `wrangler.toml` | Worker config: the `MYBROWSER` Browser Rendering binding, the `public/` static-assets directory. |
| `public/index.html` | The landing page. Served directly by the `[assets]` binding; `index.ts`'s `fetch()` only ever runs for `/api/preview`. |

## Run it locally

```bash
cd worker
npm install
npm run typecheck      # tsc --noEmit
npm run dev             # wrangler dev --remote (Browser Rendering needs a real session, not the local simulator)
```

`wrangler dev` without `--remote` cannot run Browser Rendering (there is no local emulation of
the browser binding), so `npm run dev` runs it against your real Cloudflare account.

## Deploy (your own account)

```bash
npm run deploy
```

Needs:
1. A Cloudflare account with **Browser Rendering** enabled (Workers dashboard → Browser
   Rendering → enable; the free allowance is documented at
   <https://developers.cloudflare.com/browser-rendering/platform/limits/>). This is a
   one-click, zero-cost dashboard step only the account owner can do - `wrangler deploy` will
   fail with a clear error naming the missing binding until it is enabled.
2. `wrangler login` (or an API token with Workers Scripts + Browser Rendering write scopes).

`wrangler.toml`'s `name` becomes your own `*.workers.dev` URL (or map a custom domain in the
dashboard) - deploying from your fork never touches the URL above.
