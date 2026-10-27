// POST /api/preview {url} - the hosted brand-preview API.
//
// Runs Cloudflare Browser Rendering (the MYBROWSER binding) against the reader's own site,
// extracts a brand kit with extract.ts's port of tools/brand-from-url.mjs, and returns
// brand.json plus a preview screenshot in one response - no local install. This is the move-1
// fix from STRATEGY-2026-10-23.md section 4: the brand-extraction hook moment now lands before
// the ~10-minute local toolchain install, not after it.
//
// Everything else (GET /, any other static path) is served by the [assets] binding in
// wrangler.toml straight from public/ - this file only ever runs for the one dynamic route.
import puppeteer, { type Browser } from '@cloudflare/puppeteer';
import { decideBrand, extractInPage, histogramFromDataUri } from './extract';

export interface Env {
  // Browser Rendering binding declared in wrangler.toml's [browser] block. Typed as Fetcher
  // (the real @cloudflare/workers-types shape) once `npm install` has run in this folder;
  // left as the binding's actual runtime type here so this file has no install-order dependency.
  MYBROWSER: Fetcher;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };
const PREVIEW_TIMEOUT_MS = 45_000;
const VIEWPORT = { width: 1600, height: 1000 };

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), { status, headers: JSON_HEADERS });
}

// SSRF guard: this endpoint drives a real browser to a URL a stranger on the internet supplies.
// Reject anything that is not a plain public http(s) host before a browser session is ever
// acquired - loopback, link-local/metadata (169.254.0.0/16, incl. the 169.254.169.254 cloud
// metadata address), private RFC1918 ranges, and non-http(s) schemes are all refused.
function rejectReason(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'not a valid URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http/https URLs are accepted';
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return 'local hosts are not accepted';
  if (host === '::1' || host.startsWith('[::1]')) return 'local hosts are not accepted';
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127) return 'loopback addresses are not accepted';
    if (a === 169 && b === 254) return 'link-local addresses are not accepted';
    if (a === 10) return 'private addresses are not accepted';
    if (a === 172 && b >= 16 && b <= 31) return 'private addresses are not accepted';
    if (a === 192 && b === 168) return 'private addresses are not accepted';
    if (a === 0) return 'reserved addresses are not accepted';
  }
  if (/\.(internal|local)$/i.test(host)) return 'internal hostnames are not accepted';
  return null;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(timer!); }
}

async function handlePreview(request: Request, env: Env): Promise<Response> {
  let body: { url?: string };
  try { body = await request.json(); } catch { return jsonError('expected a JSON body: {"url": "https://your-site.com"}'); }
  const rawUrl = (body.url || '').trim();
  if (!rawUrl) return jsonError('missing "url"');
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const reason = rejectReason(url);
  if (reason) return jsonError(reason, 422);

  const t0 = Date.now();
  let browser: Browser | null = null;
  try {
    browser = await withTimeout(puppeteer.launch(env.MYBROWSER), 15_000, 'browser launch');
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await withTimeout(page.goto(url, { waitUntil: 'networkidle0', timeout: PREVIEW_TIMEOUT_MS }), PREVIEW_TIMEOUT_MS, 'page load');
    await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});

    const data = await page.evaluate(extractInPage);

    const pngBase64 = (await page.screenshot({ type: 'png', encoding: 'base64' })) as unknown as string;
    const dataUri = `data:image/png;base64,${pngBase64}`;
    const histHero = await histogramFromDataUri(page, dataUri);

    const brand = decideBrand(data as any, histHero, VIEWPORT.width, VIEWPORT.height);

    return new Response(JSON.stringify({
      ok: true,
      url,
      brand,
      previewPng: dataUri,
      timingMs: Date.now() - t0,
    }), { headers: JSON_HEADERS });
  } catch (err: any) {
    const message = typeof err?.message === 'string' ? err.message : 'extraction failed';
    // Never echo the raw site's content or a stack trace back to the caller - just what broke.
    return jsonError(message.slice(0, 300), 502);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...JSON_HEADERS, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
    }
    if (pathname === '/api/preview') {
      if (request.method !== 'POST') return jsonError('POST only', 405);
      return handlePreview(request, env);
    }
    return jsonError('not found', 404);
  },
};
