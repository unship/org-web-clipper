import type { Property, Template } from '../types/types';
import { mdToOrg } from './md-to-org';

const orgKey = (name: string): string =>
  name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// Property names (lowercased) that map to standard clip fields rather than the
// extra :PROPERTIES: drawer. The Emacs side knows these and assembles them.
const STANDARD = new Set(['author', 'published', 'date', 'created', 'description', 'tags', 'title', 'url', 'source']);

export interface EmacsClip {
  properties: Property[];
  body: string;
  noteName: string;
  behavior: Template['behavior'];
  url: string;
  tags: string[];
}

export interface EmacsTransport {
  endpoint: string;
  token: string;
  template?: string;
}

export interface CapturePayload {
  template: string;
  title: string;
  body: string; // Org (converted from Markdown)
  author: string;
  published: string;
  description: string;
  created: string;
  url: string;
  tags: string[];
  behavior: Template['behavior'];
  properties: Record<string, string>; // non-standard props -> Org drawer (Emacs writes them)
}

/** Split the template's properties into the standard fields org-clipper--insert-clip
 *  knows plus an extra-properties map, and convert the body to Org. */
export function buildCapturePayload(clip: EmacsClip, template: string): CapturePayload {
  const get = (n: string): string =>
    (clip.properties.find(p => p.name.trim().toLowerCase() === n)?.value ?? '').toString().trim();
  const extra: Record<string, string> = {};
  for (const prop of clip.properties) {
    if (STANDARD.has(prop.name.trim().toLowerCase())) continue;
    const val = (prop.value ?? '').toString().trim();
    if (!val) continue;
    const key = orgKey(prop.name);
    if (key) extra[key] = val.replace(/\n+/g, ' ');
  }
  return {
    template,
    title: clip.noteName,
    body: mdToOrg(clip.body || '').trimEnd(),
    author: get('author'),
    published: get('published') || get('date'),
    description: get('description'),
    created: get('created'),
    url: clip.url,
    tags: clip.tags,
    behavior: clip.behavior,
    properties: extra,
  };
}

export async function saveToEmacs(clip: EmacsClip, cfg: EmacsTransport): Promise<{ ok: true; bytes: number }> {
  const endpoint = (cfg.endpoint || '127.0.0.1:17654').replace(/^https?:\/\//, '');
  const url = `http://${endpoint}/capture`;
  const payload = buildCapturePayload(clip, cfg.template || '');
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Org-Clipper-Token': cfg.token || '' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`cannot reach Emacs at ${url} — is the daemon running and 'M-x org-clipper-start' done? (${msg})`);
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = ((await resp.json()) as { error?: string })?.error || ''; } catch { /* ignore */ }
    throw new Error(`Emacs returned HTTP ${resp.status}${detail ? ': ' + detail : ''}`);
  }
  return { ok: true, bytes: new TextEncoder().encode(JSON.stringify(payload)).length };
}
