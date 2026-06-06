import type { Property, Template } from '../types/types';
import { mdToOrg } from './md-to-org';

const orgKey = (name: string): string =>
  name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** Render compiled template properties as an Org :PROPERTIES: drawer. */
export function propertiesToOrgDrawer(properties: Property[]): string {
  const lines: string[] = [];
  for (const prop of properties) {
    const value = (prop.value ?? '').toString().trim();
    if (!value) continue;
    const key = orgKey(prop.name);
    if (!key) continue;
    lines.push(`:${key}: ${value.replace(/\n+/g, ' ')}`);
  }
  if (lines.length === 0) return '';
  return `:PROPERTIES:\n${lines.join('\n')}\n:END:`;
}

export interface EmacsClip {
  properties: Property[];
  body: string;
  noteName: string;
  behavior: Template['behavior'];
  url: string;
  tags: string[];
}
export interface EmacsTransport { endpoint: string; token: string; template?: string; }

export function renderOrgSubtree(clip: EmacsClip): string {
  const heading = `* ${clip.noteName}`.trimEnd();
  const drawer = propertiesToOrgDrawer(clip.properties);
  const body = mdToOrg(clip.body || '').trimEnd();
  return [heading, drawer, body].filter(Boolean).join('\n');
}

export async function saveToEmacs(clip: EmacsClip, cfg: EmacsTransport): Promise<{ ok: true; bytes: number }> {
  const endpoint = (cfg.endpoint || '127.0.0.1:17654').replace(/^https?:\/\//, '');
  const url = `http://${endpoint}/capture`;
  const payload = { title: clip.noteName, content: renderOrgSubtree(clip), template: cfg.template || '', behavior: clip.behavior, url: clip.url, tags: clip.tags };
  let resp: Response;
  try {
    resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Org-Clipper-Token': cfg.token || '' }, body: JSON.stringify(payload) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`cannot reach Emacs at ${url} — is the daemon running and 'M-x org-clipper-start' done? (${msg})`);
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json() as { error?: string })?.error || ''; } catch { /* ignore */ }
    throw new Error(`Emacs returned HTTP ${resp.status}${detail ? ': ' + detail : ''}`);
  }
  return { ok: true, bytes: new TextEncoder().encode(JSON.stringify(payload)).length };
}
