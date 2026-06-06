import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildCapturePayload, saveToEmacs } from './org-note-creator';
import type { Property } from '../types/types';

const p = (name: string, value: string, type = 'text'): Property => ({ name, value, type } as Property);

describe('buildCapturePayload', () => {
  it('maps standard properties to fields and converts body md->org', () => {
    const pl = buildCapturePayload(
      { properties: [p('author', 'Jane'), p('published', '2026-06-06'), p('description', 'd')],
        body: 'Para with **bold**.', noteName: 'Title', behavior: 'create', url: 'https://x', tags: ['web'] }, 'w');
    expect(pl.title).toBe('Title');
    expect(pl.author).toBe('Jane');
    expect(pl.published).toBe('2026-06-06');
    expect(pl.description).toBe('d');
    expect(pl.url).toBe('https://x');
    expect(pl.tags).toEqual(['web']);
    expect(pl.template).toBe('w');
    expect(pl.body).toContain('*bold*');
    expect(pl.properties).toEqual({});
  });
  it('routes non-standard properties into the extra map with upcased keys', () => {
    const pl = buildCapturePayload(
      { properties: [p('author', 'Jane'), p('Reading Time', '5 min'), p('Section', 'News')],
        body: 'x', noteName: 'T', behavior: 'create', url: 'u', tags: [] }, 'w');
    expect(pl.author).toBe('Jane');
    expect(pl.properties).toEqual({ READING_TIME: '5 min', SECTION: 'News' });
  });
  it('skips empty values', () => {
    const pl = buildCapturePayload(
      { properties: [p('author', ''), p('Empty', '')], body: '', noteName: 'T', behavior: 'create', url: 'u', tags: [] }, 'w');
    expect(pl.author).toBe('');
    expect(pl.properties).toEqual({});
  });
});

describe('saveToEmacs', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('POSTs the field payload to /capture with the token', async () => {
    const calls: any[] = [];
    globalThis.fetch = vi.fn(async (url: any, opts: any) => { calls.push({ url, opts }); return { ok: true, json: async () => ({}) } as any; });
    await saveToEmacs(
      { properties: [p('author', 'Jane')], body: '**b**', noteName: 'Title', behavior: 'create', url: 'https://x', tags: ['web'] },
      { endpoint: '127.0.0.1:17654', token: 'secret', template: 'w' });
    expect(calls[0].url).toBe('http://127.0.0.1:17654/capture');
    expect(calls[0].opts.headers['X-Org-Clipper-Token']).toBe('secret');
    const sent = JSON.parse(calls[0].opts.body);
    expect(sent.title).toBe('Title');
    expect(sent.author).toBe('Jane');
    expect(sent.template).toBe('w');
    expect(sent.behavior).toBe('create');
    expect(sent.body).toContain('*b*');
  });
  it('throws a friendly error when Emacs is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(saveToEmacs({ properties: [], body: 'x', noteName: 'T', behavior: 'create', url: 'u', tags: [] },
      { endpoint: '127.0.0.1:17654', token: '' })).rejects.toThrow(/cannot reach Emacs/);
  });
  it('throws on non-200 with server detail', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'bad token' }) } as any));
    await expect(saveToEmacs({ properties: [], body: 'x', noteName: 'T', behavior: 'create', url: 'u', tags: [] },
      { endpoint: '127.0.0.1:17654', token: '' })).rejects.toThrow(/HTTP 403: bad token/);
  });
});
