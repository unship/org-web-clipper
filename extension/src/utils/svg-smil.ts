// Pure helpers for evaluating SMIL animation timing/values at a given clock time.
// No DOM access — these are unit-tested under linkedom. The DOM/canvas/GIF side
// lives in svg-converter.ts, which feeds these functions attribute strings it read
// off animation elements and applies the results to a clone for rasterization.

export interface TimingSpec {
  begin: number;
  dur: number;
  repeatCount?: number | 'indefinite';
  fill?: 'freeze' | 'remove';
}

// SMIL clock value -> seconds, or null if not a (static) clock value.
// Handles "1.6s", "300ms", "2min", "1h", bare seconds "2", and "mm:ss"/"hh:mm:ss".
// Event/syncbase values ("click+1s", "indefinite") return null so the caller skips them.
export function parseClock(value: string | null | undefined): number | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '') return null;

  if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(s)) {
    let sec = 0;
    for (const part of s.split(':')) sec = sec * 60 + parseFloat(part);
    return sec;
  }

  const m = /^([+-]?\d*\.?\d+)(ms|s|min|h)?$/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case 'ms': return n / 1000;
    case 'min': return n * 60;
    case 'h': return n * 3600;
    default: return n; // 's' or unitless
  }
}

// Fraction within the current iteration [0,1) at time t, 1 when frozen at the end,
// or null when the animation is inactive at t (not yet begun, or finished without freeze).
export function activeFraction(t: number, spec: TimingSpec): number | null {
  const { begin, dur } = spec;
  if (dur <= 0) return null;
  if (t < begin) return null;

  const local = t - begin;
  const reps = spec.repeatCount;
  const totalActive =
    reps === 'indefinite'
      ? Infinity
      : dur * (typeof reps === 'number' && reps > 0 ? reps : 1);

  if (local >= totalActive) {
    return spec.fill === 'freeze' ? 1 : null;
  }
  return (local % dur) / dur;
}

// "0 10 3" / "1,2" -> [0,10,3] / [1,2]
export function parseNums(s: string): number[] {
  return String(s)
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter(v => !Number.isNaN(v));
}

// Build the list of numeric value-vectors an animation interpolates between.
// Prefers `values` (semicolon list); otherwise from+to. Returns null when neither
// gives a usable pair (e.g. by-only or to-only, which need the element's base value).
export function buildValueVectors(opts: {
  from?: string | null;
  to?: string | null;
  by?: string | null;
  values?: string | null;
}): number[][] | null {
  if (opts.values != null && opts.values !== '') {
    const vs = opts.values.split(';').map(parseNums).filter(v => v.length > 0);
    return vs.length > 0 ? vs : null;
  }
  if (opts.from != null && opts.to != null) {
    return [parseNums(opts.from), parseNums(opts.to)];
  }
  return null;
}

// Piecewise-linear interpolation across value-vectors at fraction f, optionally
// timed by keyTimes (defaults to uniform spacing). f is clamped to [0,1].
export function interpVectors(values: number[][], keyTimes: number[] | null, f: number): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) return values[0].slice();

  const n = values.length;
  const times = keyTimes && keyTimes.length === n ? keyTimes : values.map((_, i) => i / (n - 1));
  const ff = Math.min(1, Math.max(0, f));

  let i = 0;
  while (i < n - 2 && ff > times[i + 1]) i++;

  const t0 = times[i];
  const t1 = times[i + 1];
  const seg = t1 === t0 ? 0 : (ff - t0) / (t1 - t0);
  const a = values[i];
  const b = values[i + 1];

  const out: number[] = [];
  const len = Math.max(a.length, b.length);
  for (let k = 0; k < len; k++) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    out.push(av + (bv - av) * seg);
  }
  return out;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

// Render an animateTransform value-vector as an SVG transform function string.
export function transformToString(type: string, vec: number[]): string {
  switch (type) {
    case 'translate':
      return `translate(${round(vec[0] || 0)} ${round(vec[1] || 0)})`;
    case 'scale': {
      const sx = vec[0] ?? 1;
      const sy = vec[1] ?? sx;
      return `scale(${round(sx)} ${round(sy)})`;
    }
    case 'rotate':
      return `rotate(${round(vec[0] || 0)} ${round(vec[1] || 0)} ${round(vec[2] || 0)})`;
    case 'skewX':
      return `skewX(${round(vec[0] || 0)})`;
    case 'skewY':
      return `skewY(${round(vec[0] || 0)})`;
    default:
      return '';
  }
}

const SMIL_TAGS = new Set(['animate', 'animatemotion', 'animatetransform', 'animatecolor', 'set']);

export function isSmilTag(tag: string): boolean {
  return SMIL_TAGS.has(tag.toLowerCase());
}
