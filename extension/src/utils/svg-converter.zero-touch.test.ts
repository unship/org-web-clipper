import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseHTML } from 'linkedom';
import { convertSvgsToImages } from './svg-converter';

// Clipping must be read-only as far as the page is concerned: convertSvgsToImages
// rasterizes into a CLONE and hands that to the parser, never mutating the live
// document. linkedom has no real canvas/Image, so these stubs let the rasterization
// path actually run in Node and produce a data URL — without them the converter
// bails before doing anything and the test would prove nothing.
function installRasterStubs(doc: Document): void {
  (globalThis as any).document = doc; // drawToCanvas + the `typeof document` guard
  (globalThis as any).XMLSerializer = class {
    serializeToString(el: any): string { return el.outerHTML || ''; }
  };
  (globalThis as any).Image = class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = 100;
    height = 100;
    set src(_v: string) { Promise.resolve().then(() => this.onload?.()); }
  };
  // Intercept <canvas> so getContext('2d') + toDataURL succeed; everything else real.
  const realCreate = doc.createElement.bind(doc);
  (doc as any).createElement = (tag: string) => {
    if (String(tag).toLowerCase() === 'canvas') {
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          fillStyle: '',
          fillRect() {},
          drawImage() {},
          getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        }),
        toDataURL: () => 'data:image/png;base64,AAAA',
      };
    }
    return realCreate(tag);
  };
}

function clearRasterStubs(): void {
  delete (globalThis as any).document;
  delete (globalThis as any).XMLSerializer;
  delete (globalThis as any).Image;
}

describe('convertSvgsToImages — never mutates the live document', () => {
  let live: Document;

  beforeEach(() => {
    const { document } = parseHTML(
      '<!doctype html><html><body>' +
        '<p>before</p>' +
        '<svg width="48" height="48" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"></circle></svg>' +
        '<p>after</p>' +
        '</body></html>'
    );
    live = document as unknown as Document;
    installRasterStubs(live);
  });

  afterEach(() => clearRasterStubs());

  it('returns a converted CLONE and leaves the live <svg> untouched', async () => {
    const before = live.body.innerHTML;

    const out = await convertSvgsToImages(live);

    // The page the user is looking at is byte-for-byte unchanged.
    expect(live.body.innerHTML).toBe(before);
    expect(live.querySelectorAll('svg').length).toBe(1);
    expect(live.querySelectorAll('img').length).toBe(0);

    // The document handed to the parser is a different doc carrying the image.
    expect(out).not.toBe(live);
    expect(out.querySelectorAll('svg').length).toBe(0);
    expect(out.querySelectorAll('img').length).toBe(1);
    expect(out.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/png/);
  });

  it('returns the live doc itself (no clone) when there is nothing to rasterize', async () => {
    const { document } = parseHTML('<!doctype html><html><body><p>no svg</p></body></html>');
    const noSvg = document as unknown as Document;
    installRasterStubs(noSvg);

    const out = await convertSvgsToImages(noSvg);

    // Same object → Defuddle parses the live DOM at full fidelity on the common path.
    expect(out).toBe(noSvg);
    expect(noSvg.querySelector('img')).toBeNull();
  });

  it('does not rasterize sub-24px icons, and leaves the live doc alone', async () => {
    const { document } = parseHTML(
      '<!doctype html><html><body><svg width="16" height="16"><rect/></svg></body></html>'
    );
    const iconDoc = document as unknown as Document;
    installRasterStubs(iconDoc);
    const before = iconDoc.body.innerHTML;

    const out = await convertSvgsToImages(iconDoc);

    expect(iconDoc.body.innerHTML).toBe(before);
    expect(iconDoc.querySelectorAll('svg').length).toBe(1);
    // Nothing converted → original doc returned, no <img> anywhere.
    expect(out).toBe(iconDoc);
    expect(out.querySelectorAll('img').length).toBe(0);
  });
});
