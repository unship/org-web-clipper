import { describe, it, expect } from 'vitest';
import { collectMarkdownImageUrls, collectImageUrls, fetchImages } from './fetch-images';

// A minimal Response-like factory for the injected fetch.
const enc = (s: string): Uint8Array => new Uint8Array([...s].map(c => c.charCodeAt(0)));
const mk = (status: number, ct: string, body: string) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? ct : null) },
  arrayBuffer: async () => enc(body).buffer,
});

describe('collectMarkdownImageUrls', () => {
  it('captures ![]() image markers only, not plain []() links, deduped', () => {
    expect(collectMarkdownImageUrls('![a](https://x/u1) and [link](https://x/u2) and ![](https://x/u3) text'))
      .toEqual(['https://x/u1', 'https://x/u3']);
  });
  it('returns [] for empty/undefined input', () => {
    expect(collectMarkdownImageUrls('')).toEqual([]);
  });
});

describe('collectImageUrls', () => {
  it('collects bare image links, dedups, ignores non-image urls', () => {
    const body = 'see [[https://x/a.png]] and [[https://x/a.png]] and\n' +
      '[[https://x/doc][docs]] and [[https://x/b.JPG?v=2]] and [[https://x/page]]';
    expect(collectImageUrls(body)).toEqual(['https://x/a.png', 'https://x/b.JPG?v=2']);
  });
  it('collects data:image urls', () => {
    expect(collectImageUrls('[[data:image/png;base64,AAA]]')).toEqual(['data:image/png;base64,AAA']);
  });
  it('collects image urls in [[url][desc]] form; ignores non-image [[url][desc]]', () => {
    expect(collectImageUrls(
      '[[https://x/a.png][ R0 ]] and [[https://gh/raw/vss-architecture.png][diagram]] and [[https://x/page][text]]'))
      .toEqual(['https://x/a.png', 'https://gh/raw/vss-architecture.png']);
  });
  it('collects extensionless image urls whose format is a query param (?format=png, &fm=jpg); ignores ?format=json', () => {
    expect(collectImageUrls(
      '[[https://pbs.twimg.com/media/HJvSybFbYAA5haL?format=png&name=large]] and ' +
      '[[https://images.unsplash.com/photo-1?ixlib=rb&fm=jpg&q=80]] and ' +
      '[[https://x/api?format=json]]'))
      .toEqual([
        'https://pbs.twimg.com/media/HJvSybFbYAA5haL?format=png&name=large',
        'https://images.unsplash.com/photo-1?ixlib=rb&fm=jpg&q=80']);
  });
  it('collects an extensionless body link when it is in the known (markdown) set', () => {
    expect(collectImageUrls('see [[https://cdn/opaque-id]] here', ['https://cdn/opaque-id']))
      .toEqual(['https://cdn/opaque-id']);
  });
  it('does NOT collect the same link without a known-set or heuristic match', () => {
    expect(collectImageUrls('see [[https://cdn/opaque-id]] here', [])).toEqual([]);
  });
  it('twitter scenario: the ![]() marker drives collection of the extensionless twimg image', () => {
    const known = collectMarkdownImageUrls('![Image](https://pbs.twimg.com/media/HJvSybFbYAA5haL?format=png&name=large)');
    expect(collectImageUrls(
      '#+CAPTION: Image\n[[https://pbs.twimg.com/media/HJvSybFbYAA5haL?format=png&name=large]]', known))
      .toEqual(['https://pbs.twimg.com/media/HJvSybFbYAA5haL?format=png&name=large']);
  });
});

describe('fetchImages', () => {
  const fetchImpl = (async (u: string) => {
    if (u === 'https://x/a.png') return mk(200, 'image/png', 'PNGDATA');
    if (u === 'https://x/big.png') return mk(200, 'image/png', 'X'.repeat(20));
    if (u === 'https://x/notimg') return mk(200, 'text/html', '<html>');
    if (u === 'https://x/404') return mk(404, 'image/png', '');
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;

  it('fetches a real image, base64-round-trips the bytes, derives the filename from the url', async () => {
    const imgs = await fetchImages(['https://x/a.png'], { fetchImpl });
    expect(imgs).toHaveLength(1);
    expect(imgs[0].url).toBe('https://x/a.png');
    expect(imgs[0].filename).toBe('a.png');
    expect(atob(imgs[0].dataBase64)).toBe('PNGDATA');
  });
  it('skips oversized, non-image, 404, and network-error images', async () => {
    const imgs = await fetchImages(
      ['https://x/a.png', 'https://x/big.png', 'https://x/notimg', 'https://x/404', 'https://x/dead'],
      { fetchImpl, perImageMax: 10 });
    expect(imgs.map(i => i.url)).toEqual(['https://x/a.png']);
  });
  it('decodes a data:image url without any network fetch', async () => {
    const url = 'data:image/gif;base64,' + btoa('GIF');
    const imgs = await fetchImages([url], { fetchImpl });
    expect(imgs).toHaveLength(1);
    expect(imgs[0].url).toBe(url);
    expect(atob(imgs[0].dataBase64)).toBe('GIF');
  });
  it('decodes a data:image url whose base64 contains percent-encoded whitespace (%0A)', async () => {
    // Defuddle URL-encodes literal newlines inside HTML data: src attributes as %0A.
    // atob rejects %, so parseDataUrl must strip these before calling atob.
    const raw = btoa('JPEG');
    const url = `data:image/jpeg;base64,%0A${raw}`;
    const imgs = await fetchImages([url], { fetchImpl });
    expect(imgs).toHaveLength(1);
    expect(imgs[0].url).toBe(url);
    expect(atob(imgs[0].dataBase64)).toBe('JPEG');
  });
  it('derives a filename for an extensionless CDN image from its content-type (the twimg case)', async () => {
    const url = 'https://pbs.twimg.com/media/HKAtREzaIAAMlrj?format=jpg&name=large';
    const twImpl = (async () => mk(200, 'image/jpeg', 'JPEGBYTES')) as unknown as typeof fetch;
    const imgs = await fetchImages([url], { fetchImpl: twImpl });
    expect(imgs[0].filename).toBe('HKAtREzaIAAMlrj.jpg');
    expect(imgs[0].contentType).toBe('image/jpeg');
  });
  it('stops fetching once the total byte budget is exceeded', async () => {
    const big = (async () => mk(200, 'image/png', 'X'.repeat(8))) as unknown as typeof fetch;
    const imgs = await fetchImages(['https://x/1', 'https://x/2', 'https://x/3'], { fetchImpl: big, totalMax: 10 });
    // first (8 bytes) fits; second would push total to 16 > 10 -> skipped; budget reached.
    expect(imgs).toHaveLength(1);
  });
});
