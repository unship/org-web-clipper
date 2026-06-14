import { describe, it, expect, beforeEach } from 'vitest';
import { parseHTML } from 'linkedom';
import { convertSvgsToImages } from './svg-converter';

describe('SVG Converter', () => {
  let doc: Document;

  beforeEach(() => {
    const { document } = parseHTML('<!DOCTYPE html><html><body></body></html>');
    doc = document;
  });

  it('should not error when document has no SVGs', async () => {
    const p = doc.createElement('p');
    p.textContent = 'No SVGs here';
    doc.body.appendChild(p);

    expect(doc.querySelectorAll('svg').length).toBe(0);

    // Should not throw
    await convertSvgsToImages(doc);

    expect(doc.body.textContent).toContain('No SVGs here');
  });

  it('should not error when given empty document', async () => {
    // Should not throw
    await convertSvgsToImages(doc);
  });

  it('should handle SVG elements gracefully even if conversion fails', async () => {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100');
    svg.setAttribute('height', '100');
    doc.body.appendChild(svg);

    expect(doc.querySelectorAll('svg').length).toBe(1);

    // Should not throw even if Canvas rendering fails in test environment
    await convertSvgsToImages(doc);

    // In linkedom, Canvas API is limited so SVG conversion may fail gracefully
    // The SVG should either be converted to img or left as-is without erroring
    const totalElements = doc.querySelectorAll('svg').length + doc.querySelectorAll('img').length;
    expect(totalElements).toBeGreaterThan(0);
  });
});
