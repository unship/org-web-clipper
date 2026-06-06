import { describe, it, expect, vi, afterEach } from 'vitest';
import { propertiesToOrgDrawer, saveToEmacs } from './org-note-creator';
import type { Property } from '../types/types';

const p = (name: string, value: string, type = 'text'): Property => ({ name, value, type } as Property);

describe('propertiesToOrgDrawer', () => {
  it('renders scalar properties into a drawer', () => {
    expect(propertiesToOrgDrawer([p('author', 'Jane'), p('source', 'https://x')]))
      .toBe(':PROPERTIES:\n:AUTHOR: Jane\n:SOURCE: https://x\n:END:');
  });
  it('joins multitext values with commas', () => {
    expect(propertiesToOrgDrawer([{ name: 'tags', value: 'a, b', type: 'multitext' } as Property]))
      .toBe(':PROPERTIES:\n:TAGS: a, b\n:END:');
  });
  it('skips empty values and returns empty string for no properties', () => {
    expect(propertiesToOrgDrawer([])).toBe('');
    expect(propertiesToOrgDrawer([p('empty', '')])).toBe('');
  });
  it('upcases and sanitises keys to valid drawer keys', () => {
    expect(propertiesToOrgDrawer([p('Created At', '2026-06-06')]))
      .toBe(':PROPERTIES:\n:CREATED_AT: 2026-06-06\n:END:');
  });
});

describe('saveToEmacs', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('POSTs an Org subtree to the capture endpoint with the token', async () => {
    const calls: any[] = [];
    globalThis.fetch = vi.fn(async (url: any, opts: any) => { calls.push({ url, opts }); return { ok: true, json: async () => ({}) } as any; });
    await saveToEmacs({
      properties: [{ name: 'author', value: 'Jane', type: 'text' } as any],
      body: 'Para with **bold**.', noteName: 'Title', behavior: 'create', url: 'https://x', tags: ['web'],
    }, { endpoint: '127.0.0.1:17654', token: 'secret', template: 'w' });
    expect(calls[0].url).toBe('http://127.0.0.1:17654/capture');
    expect(calls[0].opts.headers['X-Org-Clipper-Token']).toBe('secret');
    const sent = JSON.parse(calls[0].opts.body);
    expect(sent.title).toBe('Title');
    expect(sent.template).toBe('w');
    expect(sent.behavior).toBe('create');
    expect(sent.content).toContain('* Title');
    expect(sent.content).toContain(':AUTHOR: Jane');
    expect(sent.content).toContain('*bold*');
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
