// Convert inline SVG elements to raster images so they survive the Org/Markdown
// export instead of appearing as raw SVG code (or, worse, rendering blank because
// their styling lives in the page's external CSS).
//
//   - static SVGs  -> PNG  (data:image/png)
//   - animated SVGs (SMIL) -> animated GIF (data:image/gif)
//
// Everything runs in the content script (page context), where canvas, Image and
// getComputedStyle are available. SMIL animation is evaluated by hand (see
// svg-smil.ts) because Chrome does not expose animateMotion/animateTransform state
// through the DOM (getCTM/transform.animVal stay constant after setCurrentTime), so
// we cannot read frames back — we reproduce them. CSS-/script-driven SVGs are not
// reproduced; they fall back to a single static PNG frame.

import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import {
  parseClock,
  activeFraction,
  interpVectors,
  buildValueVectors,
  transformToString,
  TimingSpec,
} from './svg-smil';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ANIMATION_SELECTOR = 'animate, animateTransform, animateMotion, animateColor, set';

// Presentation properties worth inlining so a serialized SVG renders correctly when
// loaded as a standalone <img> (which gets none of the page's external stylesheets).
const PRESENTATION_PROPS = [
  'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'opacity', 'color',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'text-anchor', 'dominant-baseline', 'letter-spacing', 'word-spacing',
  'visibility', 'display',
];

const GIF_FPS = 12;
const GIF_MIN_FRAMES = 2;
const GIF_MAX_FRAMES = 48;
const GIF_MIN_CYCLE = 0.4;   // seconds
const GIF_MAX_CYCLE = 4;     // seconds
const GIF_MAX_WIDTH = 720;   // px; GIFs stay flat-coloured and small
const PNG_MAX_WIDTH = 1200;  // px; static PNGs can be sharper
const IMAGE_LOAD_TIMEOUT = 5000;

// Don't rasterize tiny SVGs — they're icons/bullets/glyphs, not figures, and
// turning a page full of them into data-URL images would bloat and slow the clip.
const MIN_RENDER_DIMENSION = 24; // px (largest side)
// Bound total work so a pathological page (many large/animated SVGs) can't hang a clip.
const CONVERSION_BUDGET_MS = 12000;

interface Size { width: number; height: number; }

function getSvgSize(svg: Element): Size {
  let width = 0;
  let height = 0;

  try {
    const box = (svg as SVGGraphicsElement).getBoundingClientRect?.();
    if (box) { width = box.width; height = box.height; }
  } catch { /* no layout (detached doc / test env) */ }

  if (!width || !height) {
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { width = vb[2]; height = vb[3]; }
  }
  if (!width) width = parseFloat(svg.getAttribute('width') || '') || 300;
  if (!height) height = parseFloat(svg.getAttribute('height') || '') || 150;

  return { width, height };
}

// Copy computed presentation styles from the live tree onto the (structurally
// identical) clone, so the serialized SVG carries its own styling.
function inlineComputedStyles(live: Element, clone: Element): void {
  const win = live.ownerDocument?.defaultView;
  if (!win || typeof win.getComputedStyle !== 'function') return;

  const liveWalker = live.ownerDocument!.createTreeWalker(live, 0x1 /* SHOW_ELEMENT */);
  const cloneWalker = clone.ownerDocument!.createTreeWalker(clone, 0x1 /* SHOW_ELEMENT */);

  let l: Node | null = live;
  let c: Node | null = clone;
  do {
    let cs: CSSStyleDeclaration;
    try { cs = win.getComputedStyle(l as Element); } catch { continue; }
    if (!cs || !cs.length) continue;

    let style = (c as Element).getAttribute('style') || '';
    for (const prop of PRESENTATION_PROPS) {
      const value = cs.getPropertyValue(prop);
      if (value && value !== 'normal' && value !== 'auto') style += `${prop}:${value};`;
    }
    (c as Element).setAttribute('style', style);
  } while ((l = liveWalker.nextNode()) && (c = cloneWalker.nextNode()));
}

// A serialized standalone SVG must declare its namespaces or <img> won't decode it.
function ensureNamespaces(svg: Element): void {
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', SVG_NS);
  const serialized = svg.outerHTML || '';
  if (/xlink:/.test(serialized) && !svg.getAttribute('xmlns:xlink')) {
    svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  }
}

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(bin);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(bin);
}

function svgToImage(svgEl: Element): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    try {
      const data = new XMLSerializer().serializeToString(svgEl);
      const url = 'data:image/svg+xml;base64,' + utf8ToBase64(data);
      const img = new Image();
      let settled = false;
      const done = (r: HTMLImageElement | null) => { if (!settled) { settled = true; resolve(r); } };
      img.onload = () => done(img);
      img.onerror = () => done(null);
      img.src = url;
      setTimeout(() => done(null), IMAGE_LOAD_TIMEOUT);
    } catch {
      resolve(null);
    }
  });
}

function drawToCanvas(img: HTMLImageElement, w: number, h: number): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// ---- static -> PNG ---------------------------------------------------------

async function convertStatic(svg: Element, size: Size): Promise<string | null> {
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
  let scale = Math.min(Math.max(dpr, 1), 2);
  if (size.width * scale > PNG_MAX_WIDTH) scale = PNG_MAX_WIDTH / size.width;

  const clone = svg.cloneNode(true) as Element;
  inlineComputedStyles(svg, clone);
  ensureNamespaces(clone);

  const img = await svgToImage(clone);
  if (!img) return null;
  const canvas = drawToCanvas(img, size.width * scale, size.height * scale);
  if (!canvas) return null;
  try { return canvas.toDataURL('image/png'); } catch { return null; }
}

// ---- animated -> GIF -------------------------------------------------------

interface AnimEl {
  el: Element;
  tag: string;
  spec: TimingSpec;
}

function readTiming(el: Element): TimingSpec | null {
  const dur = parseClock(el.getAttribute('dur'));
  if (dur == null || dur <= 0) return null;
  const begin = parseClock(el.getAttribute('begin')) ?? 0;
  const rcAttr = el.getAttribute('repeatCount');
  const repeatCount: number | 'indefinite' | undefined =
    rcAttr === 'indefinite' ? 'indefinite' : rcAttr ? parseFloat(rcAttr) || 1 : undefined;
  const fill = el.getAttribute('fill') === 'freeze' ? 'freeze' : 'remove';
  return { begin, dur, repeatCount, fill };
}

function collectAnimations(root: Element): AnimEl[] {
  const out: AnimEl[] = [];
  root.querySelectorAll(ANIMATION_SELECTOR).forEach(el => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'set') {
      const begin = parseClock(el.getAttribute('begin')) ?? 0;
      out.push({ el, tag, spec: { begin, dur: Infinity } });
      return;
    }
    const spec = readTiming(el);
    if (spec) out.push({ el, tag, spec });
  });
  return out;
}

// Loop window [t0, t0+cycle): start after every indefinite animation has begun (so
// the loop is seamless) unless a finite animation needs its full play shown.
function planLoop(anims: AnimEl[]): { t0: number; cycle: number; frames: number } {
  const finite = anims.filter(a => a.spec.repeatCount !== 'indefinite' && a.spec.dur !== Infinity);
  const indefinite = anims.filter(a => a.spec.repeatCount === 'indefinite');

  let t0 = 0;
  let cycle: number;
  if (finite.length > 0) {
    const ends = finite.map(a => {
      const reps = typeof a.spec.repeatCount === 'number' ? a.spec.repeatCount : 1;
      return a.spec.begin + a.spec.dur * reps;
    });
    cycle = Math.max(...ends);
  } else {
    t0 = Math.max(0, ...indefinite.map(a => a.spec.begin));
    cycle = Math.max(...indefinite.map(a => a.spec.dur));
  }

  cycle = Math.min(GIF_MAX_CYCLE, Math.max(GIF_MIN_CYCLE, cycle));
  const frames = Math.min(GIF_MAX_FRAMES, Math.max(GIF_MIN_FRAMES, Math.round(cycle * GIF_FPS)));
  return { t0, cycle, frames };
}

// Sample a point (and tangent angle) along a path `d` at fraction `frac`, using a
// temporary path appended to the live, attached host SVG (getTotalLength needs layout).
function pointOnPath(host: Element, d: string, frac: number): { x: number; y: number; angle: number } | null {
  let p: SVGPathElement | null = null;
  try {
    p = host.ownerDocument!.createElementNS(SVG_NS, 'path') as SVGPathElement;
    p.setAttribute('d', d);
    host.appendChild(p);
    const len = p.getTotalLength();
    if (!len || Number.isNaN(len)) return null;
    const at = Math.max(0, Math.min(len, len * frac));
    const cur = p.getPointAtLength(at);
    const ahead = p.getPointAtLength(Math.min(len, at + 1));
    const angle = Math.atan2(ahead.y - cur.y, ahead.x - cur.x) * 180 / Math.PI;
    return { x: cur.x, y: cur.y, angle };
  } catch {
    return null;
  } finally {
    if (p && p.parentNode) p.parentNode.removeChild(p);
  }
}

function resolveMotionPath(el: Element, host: Element): string | null {
  const path = el.getAttribute('path');
  if (path) return path;
  const mpath = el.querySelector('mpath');
  const href = mpath?.getAttribute('href') || mpath?.getAttribute('xlink:href');
  if (href && href.startsWith('#')) {
    const target = host.ownerDocument?.getElementById(href.slice(1));
    if (target) return target.getAttribute('d');
  }
  return null;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

// Apply the animation state at time `t` to a fresh clone of the SVG. `host` is the
// live, attached SVG used only to measure motion paths.
function applyFrame(frameRoot: Element, host: Element, anims: AnimEl[], t: number): void {
  // transform contributions per target element (motion is applied outermost)
  const transforms = new Map<Element, { motion: string; core: string }>();
  const frameAnims = frameRoot.querySelectorAll(ANIMATION_SELECTOR);

  frameAnims.forEach((el, i) => {
    const meta = anims[i];
    if (!meta) return; // structure mismatch guard
    const tag = meta.tag;
    const target = el.parentElement;
    if (!target) return;

    const bucket = transforms.get(target) || { motion: '', core: target.getAttribute('transform') || '' };

    if (tag === 'set') {
      if (t >= meta.spec.begin) {
        const name = el.getAttribute('attributeName');
        const to = el.getAttribute('to');
        if (name && to != null) target.setAttribute(name, to);
      }
      return;
    }

    const f = activeFraction(t, meta.spec);
    if (f === null) return;
    const keyTimes = el.getAttribute('keyTimes')
      ? el.getAttribute('keyTimes')!.split(';').map(Number)
      : null;

    if (tag === 'animatemotion') {
      const d = resolveMotionPath(el, host);
      if (!d) return;
      const pt = pointOnPath(host, d, f);
      if (!pt) return;
      let str = `translate(${round(pt.x)} ${round(pt.y)})`;
      const rotate = el.getAttribute('rotate');
      if (rotate === 'auto') str += ` rotate(${round(pt.angle)})`;
      else if (rotate === 'auto-reverse') str += ` rotate(${round(pt.angle + 180)})`;
      else if (rotate && !Number.isNaN(parseFloat(rotate))) str += ` rotate(${parseFloat(rotate)})`;
      bucket.motion = str;
      transforms.set(target, bucket);
      return;
    }

    if (tag === 'animatetransform' || (tag === 'animate' && el.getAttribute('attributeName') === 'transform')) {
      const type = el.getAttribute('type') || 'translate';
      const vectors = buildValueVectors({
        from: el.getAttribute('from'), to: el.getAttribute('to'),
        by: el.getAttribute('by'), values: el.getAttribute('values'),
      });
      if (!vectors) return;
      const str = transformToString(type, interpVectors(vectors, keyTimes, f));
      bucket.core = el.getAttribute('additive') === 'sum' && bucket.core ? `${bucket.core} ${str}` : str;
      transforms.set(target, bucket);
      return;
    }

    // animate / animateColor on a presentation/geometry attribute
    const name = el.getAttribute('attributeName');
    if (!name) return;
    const vectors = buildValueVectors({
      from: el.getAttribute('from'), to: el.getAttribute('to'),
      by: el.getAttribute('by'), values: el.getAttribute('values'),
    });
    if (vectors && vectors.every(v => v.length === 1)) {
      target.setAttribute(name, String(round(interpVectors(vectors, keyTimes, f)[0])));
    } else {
      // non-numeric (colour, visibility, ...): discrete snap to the active keyframe
      const raw = el.getAttribute('values')
        ? el.getAttribute('values')!.split(';').map(s => s.trim())
        : [el.getAttribute('from'), el.getAttribute('to')].filter((v): v is string => v != null);
      if (raw.length) {
        const idx = Math.min(raw.length - 1, Math.floor(f * raw.length));
        if (raw[idx] != null) target.setAttribute(name, raw[idx]);
      }
    }
  });

  for (const [target, b] of transforms) {
    const final = [b.motion, b.core].filter(Boolean).join(' ').trim();
    if (final) target.setAttribute('transform', final);
  }
}

async function convertAnimated(svg: Element, size: Size, anims: AnimEl[]): Promise<string | null> {
  const { t0, cycle, frames } = planLoop(anims);
  if (frames < GIF_MIN_FRAMES) return null;

  let scale = 1;
  if (size.width > GIF_MAX_WIDTH) scale = GIF_MAX_WIDTH / size.width;
  const cw = Math.max(1, Math.ceil(size.width * scale));
  const ch = Math.max(1, Math.ceil(size.height * scale));
  const delay = Math.max(20, Math.round((cycle / frames) * 1000));

  const styledBase = svg.cloneNode(true) as Element;
  inlineComputedStyles(svg, styledBase);
  ensureNamespaces(styledBase);

  const gif = GIFEncoder();
  let wrote = 0;
  for (let i = 0; i < frames; i++) {
    const t = t0 + (i / frames) * cycle;
    const frame = styledBase.cloneNode(true) as Element;
    applyFrame(frame, svg, anims, t);

    const img = await svgToImage(frame);
    if (!img) return null;
    const canvas = drawToCanvas(img, cw, ch);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, canvas.width, canvas.height, { palette, delay });
    wrote++;
  }
  if (wrote === 0) return null;

  gif.finish();
  return 'data:image/gif;base64,' + bytesToBase64(gif.bytes());
}

// ---- entry point -----------------------------------------------------------

function replaceWithImage(doc: Document, svg: Element, dataUrl: string, size: Size): void {
  const img = doc.createElement('img');
  img.src = dataUrl;
  img.alt = svg.getAttribute('aria-label') || svg.getAttribute('title')
    || svg.querySelector('title')?.textContent || 'Diagram';
  img.setAttribute('width', String(Math.round(size.width)));
  img.setAttribute('height', String(Math.round(size.height)));
  img.style.maxWidth = '100%';
  img.style.height = 'auto';
  svg.replaceWith(img);
}

export async function convertSvgsToImages(doc: Document): Promise<void> {
  if (typeof document === 'undefined') return; // no canvas/Image (e.g. service worker / SSR)

  const svgs = Array.from(doc.querySelectorAll('svg'));
  if (svgs.length === 0) return;

  const startedAt = Date.now();

  // Sequential: GIF encoding is CPU-heavy and motion paths share the live host.
  for (const svg of svgs) {
    if (Date.now() - startedAt > CONVERSION_BUDGET_MS) break; // leave the rest as-is
    try {
      const size = getSvgSize(svg);
      if (Math.max(size.width, size.height) < MIN_RENDER_DIMENSION) continue; // icon, skip
      const anims = collectAnimations(svg);
      const dataUrl = anims.length > 0
        ? (await convertAnimated(svg, size, anims)) ?? (await convertStatic(svg, size))
        : await convertStatic(svg, size);
      if (dataUrl) replaceWithImage(doc, svg, dataUrl, size);
    } catch {
      // Leave the original SVG in place on any failure.
    }
  }
}
