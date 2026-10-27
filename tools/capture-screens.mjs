#!/usr/bin/env node
// Screenshot capture pipeline: a real site (local dev server or production URL) to
// film/assets/screens/*.png, consistently cropped and waited-for-real-content, no manual
// screenshotting. Generalises examples/acme-site/shoot.mjs (which only knows the 3 fictional
// Acme screens) to any site and any route list.
//
//   node tools/capture-screens.mjs <base-url> --routes routes.json [--out film/assets/screens]
//   node tools/capture-screens.mjs http://localhost:3000 --routes routes.json --out film/assets/screens
//
// routes.json: an array of
//   { "name": "inbox", "path": "/app/inbox", "wait": "[data-ready]", "clip": ".app-shell",
//     "actions": [{ "click": "#close-banner" }, { "wait": 300 }] }
//
//   name      output file stem -> <out>/<name>.png
//   path      appended to <base-url> (or pass a full URL to skip the join)
//   wait      optional: a CSS selector to wait for (page.waitForSelector) before the shot -
//             this is the "no loading skeletons" guarantee; without it the tool still waits
//             for `load` + fonts.ready + a short settle, but a selector is the real fix for
//             async content (spinners, skeleton screens, client-side data fetches)
//   waitMs    optional: extra settle time in ms after `wait` resolves (default 250)
//   clip      optional: a CSS selector to crop the screenshot to (default: full viewport)
//   viewport  optional: { "width": 1920, "height": 1200 } (default 1920x1200)
//   dpr       optional: device scale factor (default 2, crisp under the camera pushes build.py
//             does - see film/README.md: product beats push in up to 3x)
//   actions   optional: an ordered list of { click: selector } | { wait: ms } | { type: {selector, text} }
//             run before the shot (dismiss a cookie banner, open a panel, fill a field, etc.)
//   cookies   optional: [{ "name": "...", "value": "...", "path": "/" }] set before navigation
//             (e.g. a demo-mode or auth cookie so the real UI renders instead of a login wall)
//
// Exits non-zero (and prints which route) on the first route that fails, so a CI-less repo
// still gets a clear failure instead of a silently blank or half-loaded screenshot.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function parseArgs(argv) {
  const a = { out: 'film/assets/screens', viewport: { width: 1920, height: 1200 }, dpr: 2, base: null, routes: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--routes') a.routes = argv[++i];
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--width') a.viewport.width = Number(argv[++i]);
    else if (v === '--height') a.viewport.height = Number(argv[++i]);
    else if (v === '--dpr') a.dpr = Number(argv[++i]);
    else if (v === '-h' || v === '--help') a.help = true;
    else if (!a.base) a.base = v;
  }
  return a;
}

function usage() {
  console.error(`Usage: node tools/capture-screens.mjs <base-url> --routes routes.json [--out film/assets/screens]
                                              [--width 1920] [--height 1200] [--dpr 2]

<base-url>  e.g. http://localhost:3000 or https://acme.app - routes.json paths are joined to it
--routes    a JSON file: an array of {name, path, wait?, waitMs?, clip?, viewport?, dpr?, actions?, cookies?}
--out       output directory for <name>.png (default: film/assets/screens)

Drives headless Chrome to each route, waits for real content (a selector you name, not a
fixed timeout), and writes one consistently-cropped PNG per route - the manual step
README.md calls the thing that "carries the film" (bring your own 3-4 screenshots).`);
}

async function runActions(page, actions, baseUrl) {
  for (const act of actions || []) {
    if (act.click) {
      await page.waitForSelector(act.click, { timeout: 10_000 });
      await page.click(act.click);
    } else if (act.type) {
      await page.waitForSelector(act.type.selector, { timeout: 10_000 });
      await page.type(act.type.selector, act.type.text, { delay: 12 });
    } else if (typeof act.wait === 'number') {
      await new Promise((r) => setTimeout(r, act.wait));
    } else if (act.wait) {
      await page.waitForSelector(act.wait, { timeout: 10_000 });
    } else {
      console.warn(`capture-screens: unknown action ${JSON.stringify(act)} (base ${baseUrl}), skipping`);
    }
  }
}

async function shootRoute(browser, baseUrl, outDir, route) {
  const url = /^https?:\/\//i.test(route.path || '') ? route.path : new URL(route.path || '/', baseUrl).href;
  const viewport = { width: route.viewport?.width || 1920, height: route.viewport?.height || 1200, deviceScaleFactor: route.dpr || 2 };
  const page = await browser.newPage();
  try {
    if (route.cookies?.length) {
      const domain = new URL(url).hostname;
      await page.setCookie(...route.cookies.map((c) => ({ domain, path: '/', ...c })));
    }
    await page.setViewport(viewport);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45_000 });
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    if (route.wait) await page.waitForSelector(route.wait, { timeout: 20_000 });
    await runActions(page, route.actions, url);
    await new Promise((r) => setTimeout(r, route.waitMs ?? 250));   // settle: CSS transitions, late paints
    const dest = path.join(outDir, `${route.name}.png`);
    if (route.clip) {
      const el = await page.waitForSelector(route.clip, { timeout: 10_000 });
      await el.screenshot({ path: dest });
    } else {
      await page.screenshot({ path: dest });
    }
    return dest;
  } finally {
    await page.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.base || !args.routes) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  const routesPath = path.resolve(process.cwd(), args.routes);
  let routes;
  try {
    routes = JSON.parse(await fs.readFile(routesPath, 'utf8'));
  } catch (err) {
    console.error(`capture-screens: cannot read/parse ${routesPath}: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(routes) || routes.length === 0) {
    console.error(`capture-screens: ${routesPath} must be a non-empty JSON array of routes`);
    process.exit(1);
  }
  for (const r of routes) {
    if (!r.name || typeof r.path !== 'string') {
      console.error(`capture-screens: every route needs a "name" and a "path": ${JSON.stringify(r)}`);
      process.exit(1);
    }
  }

  const outDir = path.resolve(root, args.out);
  await fs.mkdir(outDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--allow-file-access-from-files', '--hide-scrollbars', '--font-render-hinting=none'],
  });

  const written = [];
  try {
    for (const route of routes) {
      const t0 = Date.now();
      try {
        const dest = await shootRoute(browser, args.base, outDir, route);
        written.push(dest);
        console.log(`${route.name}: ${path.relative(process.cwd(), dest)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      } catch (err) {
        console.error(`capture-screens: route "${route.name}" (${route.path}) failed: ${err.message}`);
        process.exitCode = 1;
        break;   // fail fast: a half-finished screen set is worse than none
      }
    }
  } finally {
    await browser.close();
  }

  if (written.length === routes.length) {
    console.log(`\n${written.length} screen(s) written to ${path.relative(process.cwd(), outDir)}`);
    console.log('Wire them into film/film.json beats as "src": "assets/screens/<name>.png".');
  }
}

main();
