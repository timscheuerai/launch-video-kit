// The hosted, in-Worker port of tools/brand-from-url.mjs's colour, font and logo extraction.
//
// This is a deliberate subset of the local tool, scoped to what a stateless Worker request
// can do in well under the ~60s budget the preview API promises:
//   - extractInPage(): the exact same pure, browser-context DOM walk as the local tool's
//     function of the same name (buttons, links, headings, CSS vars, logo candidates, content
//     images). It takes a function reference with zero Node dependencies, so it ports verbatim.
//   - decideBrand(): the same colour-role maths (parseColor/lum/contrast/hsl/sat/mixc/over) and
//     the same accent-voting heuristic as the local tool's role-decision block, run against one
//     hero-viewport pixel histogram instead of the local tool's hero+full-page pair - a second,
//     full-page screenshot needs a scroll-and-stitch pass that does not fit a sub-60s budget.
//   - Font and logo *files* are out of scope here (no disk, and downloading/recolouring assets
//     costs seconds this endpoint does not have): brand.json below carries font family names and
//     a logo image URL, not saved/recoloured files. `npx launch-video-kit brand <url>` (the local
//     tool) remains the canonical, complete extraction for an actual film - this endpoint exists
//     to show the brand lives in the kit before anything is installed, per
//     STRATEGY-2026-10-23.md section 4.

// ------------------------------------------------------------------ colour maths
// Ported verbatim from tools/brand-from-url.mjs (pure functions, no Node APIs).

export type RGBA = [number, number, number, number?];

export function parseColor(s: string | null | undefined): RGBA | null {
  if (!s) return null;
  const str = String(s).trim();
  const m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  const hexm = str.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hexm) {
    let h = hexm[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  return null;
}

export const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
function lin(v: number) { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
export function lum(c: RGBA) { return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); }
export function contrast(a: RGBA, b: RGBA) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
export function hsl(c: RGBA): [number, number, number] {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const l = (mx + mn) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, s, l];
}
export function sat(c: RGBA) { const [, s, l] = hsl(c); return s * (1 - Math.abs(2 * l - 1)); }
export function dist(a: RGBA, b: RGBA) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
export function mixc(a: RGBA, b: RGBA, t: number): RGBA { return [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)).concat(1) as RGBA; }
export function over(c: RGBA, bg: RGBA): RGBA { const a = c[3] ?? 1; return [0, 1, 2].map((i) => Math.round(c[i]! * a + bg[i]! * (1 - a))).concat(1) as RGBA; }
export function hex(c: RGBA) { return '#' + c.slice(0, 3).map((v) => Math.round(clamp(v as number, 0, 255)).toString(16).padStart(2, '0')).join(''); }
export function rgba(c: RGBA, a: number) { return `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${a})`; }
export function opaque(c: RGBA | null): c is RGBA { return !!c && (c[3] ?? 1) > 0.5; }
export function isNeutral(c: RGBA) { return sat(c) < 0.08; }
const GENERIC = /^(system-ui|-apple-system|blinkmacsystemfont|sans-serif|serif|monospace|ui-sans-serif|ui-serif|ui-monospace|segoe ui|arial|helvetica)$/i;

// ------------------------------------------------------------------ in-page extraction
// Ported from tools/brand-from-url.mjs's extractInPage(), trimmed of the font-face CSS
// parsing (no font *files* are extracted here, see the header note above). Passed by
// reference to page.evaluate(), so it must stay a plain, self-contained function: no
// closures over anything outside itself.

export function extractInPage() {
  const vw = innerWidth, vh = innerHeight;
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const norm = (v: string | null) => {
    if (!v) return null;
    v = String(v).trim();
    if (/^rgba?\(/i.test(v)) return v;
    try {
      cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#010203'; cx.fillStyle = v;
      if (cx.fillStyle === '#010203' && !/^#010203$/i.test(v)) return null;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      return `rgba(${d[0]}, ${d[1]}, ${d[2]}, ${(d[3] / 255).toFixed(3)})`;
    } catch { return null; }
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.05;
  };
  const absRect = (el: Element) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };
  const text = (el: Element | null) => (el ? ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const style = (el: Element | null) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(), text: text(el).slice(0, 140), rect: absRect(el),
      color: norm(cs.color), background: norm(cs.backgroundColor), backgroundImage: cs.backgroundImage !== 'none' ? cs.backgroundImage.slice(0, 200) : null,
      textFill: (cs as any).webkitTextFillColor ? norm((cs as any).webkitTextFillColor) : null,
      fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontSize: parseFloat(cs.fontSize), letterSpacing: cs.letterSpacing, lineHeight: cs.lineHeight,
      borderColor: norm(cs.borderTopColor), borderWidth: parseFloat(cs.borderTopWidth) || 0, radius: parseFloat(cs.borderTopLeftRadius) || 0,
      padding: [parseFloat(cs.paddingTop) || 0, parseFloat(cs.paddingLeft) || 0], position: cs.position,
    };
  };

  const h1 = ([...document.querySelectorAll('h1')].filter(visible).sort((a, b) => b.getBoundingClientRect().height * parseFloat(getComputedStyle(b).fontSize) - a.getBoundingClientRect().height * parseFloat(getComputedStyle(a).fontSize))[0]
    || [...document.querySelectorAll('h2, [class*=hero i] [class*=title i], [class*=headline i]')].filter(visible)[0]) as HTMLElement | undefined;
  const h2s = [...document.querySelectorAll('h2')].filter(visible);
  const ps = [...document.querySelectorAll('p')].filter((p) => visible(p) && text(p).length > 40).slice(0, 12);
  const header = (document.querySelector('header') || document.querySelector('[role=banner]') || document.querySelector('nav')?.closest('div')) as HTMLElement | null;
  const footer = document.querySelector('footer') || document.querySelector('[role=contentinfo]');

  let subhead = '';
  if (h1) {
    const all = [...document.querySelectorAll('p, h2, [class*=sub i]')].filter(visible);
    const after = all.find((el) => (h1.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && text(el).length > 30 && el.getBoundingClientRect().top < h1.getBoundingClientRect().bottom + 500);
    if (after) subhead = text(after).slice(0, 240);
  }

  const navRoot = header || document.querySelector('nav');
  const nav = navRoot ? [...new Set([...navRoot.querySelectorAll('nav a, nav button, a')].filter(visible).map(text).filter((t) => t && t.length <= 24 && t.split(' ').length <= 3))].slice(0, 12) : [];

  const ctas: any[] = [];
  for (const el of document.querySelectorAll('a, button, [role=button], input[type=submit]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.top + scrollY > vh * 3.2 || r.height < 24 || r.height > 90 || r.width < 50 || r.width > 480) continue;
    const t = text(el) || (el as HTMLInputElement).value || el.getAttribute('aria-label') || '';
    if (!t || t.length > 36) continue;
    const s = style(el)!;
    let bg = s.background, box: Element = el;
    if (!bg || bg.endsWith(', 0)') || bg.endsWith(', 0.000)')) {
      const kid = [...el.querySelectorAll('*')].find((k) => { const b = norm(getComputedStyle(k).backgroundColor); return b && !/, 0(\.0+)?\)$/.test(b); });
      if (kid) { bg = norm(getComputedStyle(kid).backgroundColor); box = kid; }
    }
    const filled = !!bg && !/, 0(\.0+)?\)$/.test(bg);
    const outlined = s.borderWidth >= 1 && !!s.borderColor && !/, 0(\.0+)?\)$/.test(s.borderColor);
    if (!filled && !outlined) continue;
    const cs = getComputedStyle(box);
    ctas.push({ ...s, background: bg, color: norm(cs.color) || s.color, radius: parseFloat(cs.borderTopLeftRadius) || s.radius, text: t.slice(0, 36), filled, outlined, inHeader: !!(header && header.contains(el)) });
    if (ctas.length >= 30) break;
  }

  const links = [...document.querySelectorAll('main a, article a, p a, section a')].filter(visible).slice(0, 60).map((a) => norm(getComputedStyle(a).color)).filter(Boolean);

  const blocks: any[] = [];
  for (const el of document.querySelectorAll('body, main, section, header, footer, div, article, aside')) {
    const r = el.getBoundingClientRect();
    if (r.width < vw * 0.5 || r.height < 120) continue;
    const bg = norm(getComputedStyle(el).backgroundColor);
    if (!bg || /, 0(\.0+)?\)$/.test(bg)) continue;
    blocks.push({ tag: el.tagName.toLowerCase(), bg, area: Math.round(r.width * r.height), y: Math.round(r.top + scrollY), h: Math.round(r.height) });
    if (blocks.length > 400) break;
  }

  const cards: any[] = [];
  for (const el of document.querySelectorAll('div, li, article, section, a')) {
    const r = el.getBoundingClientRect();
    if (r.width < 180 || r.width > 900 || r.height < 90 || r.height > 800) continue;
    const cs = getComputedStyle(el);
    const rad = parseFloat(cs.borderTopLeftRadius) || 0;
    if (rad < 4) continue;
    const bg = norm(cs.backgroundColor);
    if (!bg || /, 0(\.0+)?\)$/.test(bg)) continue;
    const pbg = el.parentElement ? norm(getComputedStyle(el.parentElement).backgroundColor) : null;
    if (pbg === bg) continue;
    cards.push({ bg, radius: rad });
    if (cards.length > 200) break;
  }

  const vars: Record<string, { raw: string; rgba: string }> = {};
  const rootCs = getComputedStyle(document.documentElement), bodyCs = getComputedStyle(document.body);
  for (const cs of [rootCs, bodyCs]) {
    for (let i = 0; i < cs.length; i++) {
      const name = cs[i];
      if (!name.startsWith('--') || vars[name]) continue;
      const raw = cs.getPropertyValue(name).trim();
      if (!raw || raw.length > 80) continue;
      let val: string | null = null;
      if (/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\()/i.test(raw)) val = norm(raw);
      else if (/^\d+(\.\d+)?(deg)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$/.test(raw)) val = norm(`hsl(${raw})`);
      if (val) vars[name] = { raw, rgba: val };
    }
  }

  const famUse: Record<string, number> = {};
  for (const el of document.querySelectorAll('h1, h2, h3, h4, p, li, a, button, span, div')) {
    if (!el.firstChild || el.children.length > 3) continue;
    const t = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => (n.textContent || '').trim()).join(' ');
    if (t.length < 2) continue;
    const cs = getComputedStyle(el);
    const fam = cs.fontFamily;
    famUse[fam] = (famUse[fam] || 0) + t.length * parseFloat(cs.fontSize);
  }
  const mono = document.querySelector('code, pre, kbd, samp');

  const meta = (sel: string) => document.querySelector(sel)?.getAttribute('content')?.trim() || '';

  const origin = location.origin;
  const home = (a: HTMLAnchorElement) => {
    try { const u = new URL(a.href, location.href); return (u.origin === origin || u.protocol === 'file:') && (u.pathname === '/' || u.pathname === '' || /\/index\.html?$/.test(u.pathname) || u.pathname === location.pathname) && !u.hash; } catch { return false; }
  };
  const words = (s: string | null) => (s || '').toLowerCase();
  const siteName = meta('meta[property="og:site_name"]') || document.title.split(/\s[|\-–—:·•]\s/)[0];
  const cand = new Set<Element>();
  for (const el of document.querySelectorAll('header a, nav a, [role=banner] a, a[aria-label], [class*=logo i], [id*=logo i], img[alt*=logo i], img[src*=logo i], svg[aria-label], a > svg, a > img')) {
    const r = el.getBoundingClientRect();
    if (r.top + scrollY > 260 || r.width < 12 || r.height < 10) continue;
    cand.add(el.tagName === 'svg' || el.tagName === 'IMG' ? (el.closest('a') || el) : el);
  }
  const scored: any[] = [];
  let idx = 0;
  for (const el of cand) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 520 || r.height > 160) continue;
    const svgs = el.tagName === 'svg' ? [el] : [...el.querySelectorAll('svg')].filter(visible);
    const imgs = (el.tagName === 'IMG' ? [el] : [...el.querySelectorAll('img')].filter(visible)) as HTMLImageElement[];
    if (!svgs.length && !imgs.length) {
      const t = text(el);
      if (!(t && t.length <= 24 && siteName && words(t).includes(words(siteName).split(' ')[0]))) continue;
    }
    const attrs = [(el as any).className?.baseVal ?? (el as any).className, el.id, el.getAttribute('aria-label'), el.getAttribute('title'), ...imgs.map((i) => i.alt + ' ' + i.src), ...svgs.map((s) => (s.getAttribute('aria-label') || '') + ' ' + ((s as any).className?.baseVal || ''))].map(words).join(' ');
    let score = 0;
    if (header && header.contains(el)) score += 3;
    if (el.tagName === 'A' && home(el as HTMLAnchorElement)) score += 4;
    if (/logo|brand|wordmark/.test(attrs)) score += 4;
    if (siteName && attrs.includes(words(siteName).split(' ')[0])) score += 2;
    if (r.left < 480 && r.top + scrollY < 140) score += 3;
    if (svgs.length || imgs.length) score += 2;
    if (r.width >= 24 && r.width <= 360 && r.height >= 14 && r.height <= 110) score += 1;
    if (/icon|menu|search|close|chevron|arrow|burger|hamburger/.test(attrs)) score -= 5;
    const id = `bfu-${idx++}`;
    scored.push({ id, score, tag: el.tagName.toLowerCase(), rect: absRect(el), svgs: svgs.length, imgs: imgs.map((i) => ({ src: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight, alt: i.alt })), text: text(el).slice(0, 40), label: el.getAttribute('aria-label') || imgs[0]?.alt || '' });
  }
  scored.sort((a, b) => b.score - a.score);

  const images: any[] = [];
  const seen = new Set<string>();
  for (const img of document.querySelectorAll('img')) {
    if (!visible(img)) continue;
    const src = (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src;
    if (!src || seen.has(src) || /\.svg(\?|$)/i.test(src) || src.startsWith('data:image/svg')) continue;
    if (img.closest('header, nav, footer')) continue;
    if ((img as HTMLImageElement).naturalWidth < 480 || (img as HTMLImageElement).naturalHeight < 270) continue;
    const r = img.getBoundingClientRect();
    seen.add(src);
    images.push({ src, w: (img as HTMLImageElement).naturalWidth, h: (img as HTMLImageElement).naturalHeight, alt: ((img as HTMLImageElement).alt || '').slice(0, 120), shown: Math.round(r.width * r.height) });
  }
  images.sort((a, b) => b.shown - a.shown);

  return {
    title: document.title.trim(), lang: document.documentElement.lang || '',
    meta: {
      description: meta('meta[name="description"]'), ogTitle: meta('meta[property="og:title"]'), ogDescription: meta('meta[property="og:description"]'),
      ogSiteName: meta('meta[property="og:site_name"]'), ogImage: meta('meta[property="og:image"]'), themeColor: meta('meta[name="theme-color"]'),
      applicationName: meta('meta[name="application-name"]'),
    },
    styles: { html: style(document.documentElement), body: style(document.body), h1: style(h1 || null), h2: h2s.slice(0, 3).map(style), p: ps.map(style), header: style(header), footer: style(footer as Element | null), mono: mono ? style(mono) : null },
    copy: { h1: h1 ? text(h1).slice(0, 160) : '', subhead, h2: [...new Set(h2s.map(text).filter((t) => t && t.length < 120))].slice(0, 12), nav },
    ctas, links, blocks, cards, vars, famUse,
    monoFamily: mono ? getComputedStyle(mono).fontFamily : '',
    logos: scored.slice(0, 12), images: images.slice(0, 24),
    page: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, url: location.href },
  };
}
export type ExtractedPage = ReturnType<typeof extractInPage>;

// ------------------------------------------------------------------ pixel histogram
// Runs in the same live page (not a second blank tab, unlike the local tool - one page is
// enough when the only input is the screenshot the Worker already took). `src` is a
// `data:image/png;base64,...` data URI of that screenshot.

export async function histogramFromDataUri(page: { evaluate: Function }, src: string): Promise<Array<{ rgb: [number, number, number]; share: number }>> {
  return page.evaluate(async (dataUri: string) => {
    const img = new Image();
    img.src = dataUri;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d')!;
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const bins = new Map<number, [number, number, number, number]>();
    let n = 0;
    for (let y = 0; y < c.height; y += 3) {
      for (let xx = 0; xx < c.width; xx += 3) {
        const i = (y * c.width + xx) * 4;
        const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
        let b = bins.get(k);
        if (!b) { b = [0, 0, 0, 0]; bins.set(k, b); }
        b[0]++; b[1] += d[i]; b[2] += d[i + 1]; b[3] += d[i + 2]; n++;
      }
    }
    return [...bins.values()].sort((a, b) => b[0] - a[0]).slice(0, 40)
      .map((b) => ({ rgb: [Math.round(b[1] / b[0]), Math.round(b[2] / b[0]), Math.round(b[3] / b[0])] as [number, number, number], share: +(b[0] / n).toFixed(4) }));
  }, src);
}

// ------------------------------------------------------------------ role decision
// Ported from tools/brand-from-url.mjs's main() role-decision block (lines ~598-757), with
// the full-page histogram input dropped (hero only, see the header note) and all font/logo
// *file* output dropped (names and a source URL only).

export interface BrandKit {
  mode: 'light' | 'dark';
  name: string;
  tagline: string;
  nav: string[];
  colors: Record<string, string>;
  radius: number;
  monochrome: boolean;
  fonts: { display: { family: string; weight: number; tracking: string }; body: { family: string; weight: number }; mono: { family: string } };
  logo: { src: string | null; score: number } | null;
  notes: string[];
}

export function decideBrand(data: ExtractedPage, histHero: Array<{ rgb: [number, number, number]; share: number }>, W: number, H: number): BrandKit {
  const notes: string[] = [];
  const S = data.styles;
  const pc = (s: string | null | undefined) => parseColor(s as any);
  const bodyBg = ([S.body?.background, S.html?.background].map(pc).find(opaque) || [255, 255, 255, 1]) as RGBA;

  const blockArea = new Map<string, number>();
  for (const b of data.blocks as any[]) {
    const c = pc(b.bg); if (!opaque(c)) continue;
    const k = hex(c!); blockArea.set(k, (blockArea.get(k) || 0) + b.area);
  }
  const pageArea = W * Math.max(data.page.height, H);
  const top = histHero[0];
  let siteGround = bodyBg;
  if (top && top.share >= 0.18) {
    const near = [...blockArea.keys()].map((k) => parseColor(k) as RGBA).concat([bodyBg]).sort((a, b) => dist(a, top.rgb as any) - dist(b, top.rgb as any))[0];
    siteGround = near && dist(near, top.rgb as any) < 14 ? near : ([...top.rgb, 1] as RGBA);
  }
  const mode: 'light' | 'dark' = lum(siteGround) < 0.2 ? 'dark' : 'light';

  const h1c = (() => {
    const h = S.h1; if (!h) return null;
    const fill = pc(h.textFill);
    if (fill && (fill[3] ?? 1) < 0.1) return null;
    const c = pc(h.color); return c && (c[3] ?? 1) > 0.5 ? over(c, siteGround) : null;
  })();
  const bodyText = over((pc(S.body?.color) || [20, 20, 20, 1]) as RGBA, siteGround);

  const acc = new Map<string, { c: RGBA; w: number; why: string[] }>();
  const addAcc = (c: RGBA | null, w: number, why: string) => {
    if (!c) return; c = over(c, siteGround);
    if ((c[3] ?? 1) < 0.5) return;
    const s = sat(c), l = lum(c);
    if (s < 0.2 || l > 0.9 || l < 0.012) return;
    let key = [...acc.keys()].find((k) => dist(parseColor(k)!, c!) < 28);
    if (!key) { key = hex(c); acc.set(key, { c, w: 0, why: [] }); }
    const e = acc.get(key)!; e.w += w * (0.5 + s); if (!e.why.includes(why)) e.why.push(why);
  };
  const ctaFilled = (data.ctas as any[]).filter((b) => b.filled);
  ctaFilled.forEach((b) => addAcc(pc(b.background), b.rect.y < H * 1.2 ? 8 : 4, 'button background'));
  (data.ctas as any[]).filter((b) => !b.filled && b.outlined).forEach((b) => { addAcc(pc(b.borderColor), 2, 'outline button'); addAcc(pc(b.color), 1.5, 'outline button text'); });
  (data.links as any[]).slice(0, 30).forEach((l) => addAcc(pc(l), 0.6, 'link colour'));
  Object.entries(data.vars).forEach(([k, v]) => {
    if (/foreground|text|fg|border|muted|bg-/i.test(k)) return;
    if (/primary|brand|accent/i.test(k)) addAcc(pc(v.rgba), 4, `css var ${k}`);
    else if (/main|highlight|cta/i.test(k)) addAcc(pc(v.rgba), 1.5, `weak css var ${k}`);
  });
  if (data.meta.themeColor) addAcc(pc(data.meta.themeColor), 2, 'theme-color');
  histHero.forEach((b) => addAcc([...b.rgb, 1] as RGBA, b.share * 60, 'hero pixels'));

  const pickAccent = () => [...acc.entries()]
    .filter(([, e]) => e.why.some((w) => !/pixels|weak css var/.test(w)) || e.w >= 9)
    .sort((a, b) => b[1].w - a[1].w)[0];

  const best = (data.logos as any[]).find((l) => l.score >= 7) || null;

  const accentEntry = pickAccent();
  let accent: RGBA, monochrome = false;
  if (accentEntry && accentEntry[1].w >= 3) {
    accent = accentEntry[1].c;
  } else {
    const cta = ctaFilled.filter((b) => { const c = pc(b.background); return c && contrast(over(c, siteGround), siteGround) >= 3; }).sort((a, b) => a.rect.y - b.rect.y)[0];
    accent = cta ? over(pc(cta.background)!, siteGround) : (h1c || bodyText);
    monochrome = true;
  }
  const accentCta = ctaFilled.find((b) => { const c = pc(b.background); return c && dist(over(c, siteGround), accent) < 30; });
  let accentInk: RGBA;
  if (accentCta && pc(accentCta.color) && contrast(over(pc(accentCta.color)!, accent), accent) >= 3) accentInk = over(pc(accentCta.color)!, accent);
  else accentInk = contrast([255, 255, 255, 1], accent) >= contrast([17, 17, 17, 1], accent) ? [255, 255, 255, 1] : [17, 17, 17, 1];

  let ground: RGBA, ink: RGBA, inkSecondary: RGBA, dark: RGBA, darkInk: RGBA, surface: RGBA;
  const darkCands = [...blockArea.entries()].map(([k, a]) => [parseColor(k) as RGBA, a] as [RGBA, number]).filter(([c, a]) => lum(c) < 0.045 && a > pageArea * 0.01)
    .concat(histHero.filter((b) => lum([...b.rgb, 1] as RGBA) < 0.045 && b.share > 0.01).map((b) => [[...b.rgb, 1] as RGBA, b.share * pageArea] as [RGBA, number]))
    .sort((a, b) => b[1] - a[1]);
  if (mode === 'light') {
    ground = siteGround;
    ink = h1c && contrast(h1c, ground) >= 4 ? h1c : contrast(bodyText, ground) >= 4 ? bodyText : [17, 17, 17, 1];
    inkSecondary = mixc(ink, ground, 0.38);
    dark = darkCands.length ? darkCands[0][0] : mixc(accent, [8, 8, 10, 1], monochrome ? 0.6 : 0.84);
    darkInk = ground;
  } else {
    dark = siteGround;
    darkInk = h1c && lum(h1c) > 0.5 ? h1c : lum(bodyText) > 0.5 ? bodyText : [250, 250, 250, 1];
    const light = [...blockArea.entries()].map(([k, a]) => [parseColor(k) as RGBA, a] as [RGBA, number]).filter(([c, a]) => lum(c) > 0.82 && isNeutral(c) && a > pageArea * 0.02).sort((a, b) => b[1] - a[1])[0]
      || histHero.filter((b) => lum([...b.rgb, 1] as RGBA) > 0.82 && b.share > 0.02).map((b) => [[...b.rgb, 1] as RGBA, b.share] as [RGBA, number])[0];
    ground = light ? light[0] : mixc([255, 255, 255, 1], dark, 0.04);
    ink = lum(dark) < 0.01 ? [10, 10, 10, 1] : mixc(dark, [0, 0, 0, 1], 0.35);
    inkSecondary = mixc(ink, ground, 0.42);
    notes.push('dark-mode site: dark and dark_ink come from the page, ground and ink are derived for light statement scenes');
  }
  const cardCounts = new Map<string, number>();
  for (const c of data.cards as any[]) { const k = pc(c.bg); if (opaque(k) && dist(k!, ground) > 6 && lum(k!) > 0.6) { const h = hex(k!); cardCounts.set(h, (cardCounts.get(h) || 0) + 1); } }
  const cardTop = [...cardCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  surface = cardTop && cardTop[1] >= 2 ? parseColor(cardTop[0])! : lum(ground) > 0.97 ? [255, 255, 255, 1] : mixc(ground, [255, 255, 255, 1], 0.7);

  const hueVar = (re: RegExp, lo: number, hi: number) => {
    for (const [k, v] of Object.entries(data.vars)) {
      if (!re.test(k)) continue;
      const c = pc(v.rgba); if (!c || sat(c) < 0.25 || lum(c) < 0.04 || lum(c) > 0.42) continue;
      const h = hsl(c)[0];
      if (lo < hi ? h >= lo && h <= hi : h >= lo || h <= hi) return c;
    }
    return null;
  };
  const success = hueVar(/success|green|positive|good/i, 80, 175) || [31, 122, 77, 1];
  const danger = hueVar(/danger|error|destructive|red|negative|critical/i, 340, 25) || [194, 69, 61, 1];

  const med = (xs: number[]) => { const s = xs.filter((x) => x > 0).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const cardRad = med((data.cards as any[]).map((c) => c.radius));
  const btnRad = med(ctaFilled.map((b) => b.radius));
  const radius = Math.round(clamp(cardRad ?? (btnRad && btnRad < 100 ? btnRad : 12), 0, 32));

  const colors: Record<string, string> = {
    ground: hex(ground), surface: hex(surface), ink: hex(ink), ink_secondary: hex(inkSecondary),
    accent: hex(accent), accent_ink: hex(accentInk), dark: hex(dark), dark_ink: hex(darkInk),
    highlight: rgba(accent, monochrome ? 0.14 : 0.2), success: hex(success), danger: hex(danger),
  };
  let aod = accent;
  for (let t = 0; t <= 0.8 && contrast(aod, dark) < 3; t += 0.05) aod = mixc(accent, [255, 255, 255, 1], t);
  colors.accent_on_dark = contrast(aod, dark) >= 3 && !monochrome ? hex(aod) : hex(darkInk);
  if (monochrome) notes.push('monochrome brand: the accent is the primary button colour; consider a signature colour by hand');

  // ---- name, tagline, nav (ported from main()'s copy block)
  const domain = (() => { try { const u = new URL(data.page.url); return u.protocol === 'file:' || /^(localhost|127\.|\[?::1)/.test(u.hostname) ? '' : u.hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const domRoot = domain.split('.').slice(-2)[0] || '';
  const titleParts = data.title.split(/\s+[|\-–—:·•]\s+/).map((s) => s.trim()).filter(Boolean);
  const strip = (s: string | undefined) => (s || '').replace(/\b(logo|home ?page|home|go to)\b/gi, '').replace(/\s+/g, ' ').trim();
  const nameCands = [data.meta.ogSiteName, data.meta.applicationName, strip(best?.label), strip(best?.text), ...titleParts].filter((s): s is string => !!s && s.length <= 40);
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const name = nameCands.find((s) => domRoot && flat(s).includes(flat(domRoot)) && s.split(' ').length <= 4)
    || nameCands.find((s) => s.split(' ').length <= 3)
    || (domRoot ? domRoot[0].toUpperCase() + domRoot.slice(1) : 'Brand');
  const wc = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const firstSentence = (s: string | undefined) => (s || '').split(/(?<=[.!?])\s/)[0];
  const shorten = (s: string, n = 9) => { const w = s.split(/\s+/); return w.length <= n ? s : w.slice(0, n).join(' ').replace(/[,;:]$/, ''); };
  const tagCands = [
    ...titleParts.filter((p) => flat(p) !== flat(name) && !flat(p).includes(flat(name))),
    data.copy.h1, firstSentence(data.meta.ogDescription), firstSentence(data.meta.description),
  ].filter((s): s is string => !!s && wc(s) >= 2);
  const tagline = (tagCands.find((s) => wc(s) <= 9) || shorten(tagCands[0] || data.meta.description || name)).replace(/\s+/g, ' ').trim();
  const ctaLabels = [...new Set((data.ctas as any[]).map((b) => b.text))].slice(0, 10);
  const nav = (data.copy.nav as string[]).filter((t) => flat(t) !== flat(name) && !ctaLabels.includes(t) && !/^(sign in|log in|login|sign up|menu)$/i.test(t));

  // ---- fonts: family names only (no file download in this endpoint)
  const famRank = Object.entries(data.famUse).sort((a, b) => b[1] - a[1]);
  const h1Fam = S.h1?.fontFamily || famRank[0]?.[0] || 'system-ui';
  const bodyFam = S.p[0]?.fontFamily || S.body?.fontFamily || famRank[0]?.[0] || 'system-ui';
  const firstReal = (stack: string) => stack.split(',').map((f) => f.trim().replace(/^["']|["']$/g, '')).find((f) => f && !GENERIC.test(f)) || stack.split(',')[0].trim().replace(/^["']|["']$/g, '');
  const displayRaw = firstReal(h1Fam), bodyRaw = firstReal(bodyFam);
  const displayWeight = parseInt(S.h1?.fontWeight || '600', 10) || 600;
  const bodyWeight = parseInt(S.p[0]?.fontWeight || S.body?.fontWeight || '400', 10) || 400;
  const ls = S.h1?.letterSpacing;
  const tracking = !ls || ls === 'normal' ? '-0.02em' : `${(parseFloat(ls) / (S.h1!.fontSize || 16)).toFixed(3)}em`;
  const monoRaw = data.monoFamily ? firstReal(data.monoFamily) : 'ui-monospace';

  return {
    mode, name, tagline, nav, colors, radius, monochrome,
    fonts: {
      display: { family: displayRaw, weight: displayWeight, tracking },
      body: { family: bodyRaw, weight: bodyWeight },
      mono: { family: GENERIC.test(monoRaw) ? 'ui-monospace' : monoRaw },
    },
    logo: best ? { src: best.imgs?.[0]?.src || null, score: best.score } : null,
    notes,
  };
}
