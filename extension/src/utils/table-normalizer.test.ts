import { describe, test, expect, beforeAll } from 'vitest';
import { parseHTML } from 'linkedom';
import { normalizeTableSpans } from './table-normalizer';

beforeAll(() => {
	// The util uses the ambient DOMParser (present in every browser context the
	// extension runs in). linkedom's raw DOMParser doesn't auto-wrap a bare
	// <table> fragment into <body> the way a real browser HTML parser does, so
	// shim it to parse a full document — matching browser fragment behavior.
	(globalThis as any).DOMParser = class {
		parseFromString(html: string, _type: string): Document {
			const { document } = parseHTML(
				`<!doctype html><html><head></head><body>${html}</body></html>`
			);
			return document as unknown as Document;
		}
	};
});

// Re-parse output and read the grid back as a 2D array of cell text, so the
// assertions describe the table shape rather than its serialization.
function grid(html: string): string[][] {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	const table = document.querySelector('table')!;
	return Array.from(table.querySelectorAll('tr')).map(tr =>
		Array.from(tr.children)
			.filter((c: any) => c.tagName === 'TD' || c.tagName === 'TH')
			.map((c: any) => (c.textContent || '').replace(/\s+/g, ' ').trim())
	);
}

function hasSpanAttrs(html: string): boolean {
	return /\b(colspan|rowspan)\s*=/.test(html);
}

describe('normalizeTableSpans', () => {
	test('expands a colspan section row into empty cells (z.ai shape)', () => {
		const html =
			'<table><thead><tr><th>Benchmark</th><th>GLM-5.2</th><th>GLM-5.1</th><th>Opus</th></tr></thead>' +
			'<tbody>' +
			'<tr><td>Reasoning</td><td colspan="3"></td></tr>' +
			'<tr><td>HLE</td><td>40.5</td><td>31.0</td><td>49.8</td></tr>' +
			'</tbody></table>';
		const out = normalizeTableSpans(html);
		expect(hasSpanAttrs(out)).toBe(false);
		expect(grid(out)).toEqual([
			['Benchmark', 'GLM-5.2', 'GLM-5.1', 'Opus'],
			['Reasoning', '', '', ''],
			['HLE', '40.5', '31.0', '49.8'],
		]);
	});

	test('keeps the value in the top-left and pads the rest of a colspan', () => {
		const html = '<table><tbody><tr><td colspan="3">Wide</td></tr><tr><td>a</td><td>b</td><td>c</td></tr></tbody></table>';
		expect(grid(normalizeTableSpans(html))).toEqual([
			['Wide', '', ''],
			['a', 'b', 'c'],
		]);
	});

	test('expands rowspan downward into empty cells, shifting later cells right', () => {
		// Col 0 spans 2 rows; the 2nd row has one explicit cell that must land in col 1.
		const html =
			'<table><tbody>' +
			'<tr><td rowspan="2">Merged</td><td>r1c2</td></tr>' +
			'<tr><td>r2c2</td></tr>' +
			'</tbody></table>';
		expect(grid(normalizeTableSpans(html))).toEqual([
			['Merged', 'r1c2'],
			['', 'r2c2'],
		]);
	});

	test('handles combined colspan+rowspan', () => {
		// Top-left cell covers a 2x2 block.
		const html =
			'<table><tbody>' +
			'<tr><td colspan="2" rowspan="2">Block</td><td>c</td></tr>' +
			'<tr><td>f</td></tr>' +
			'<tr><td>g</td><td>h</td><td>i</td></tr>' +
			'</tbody></table>';
		expect(grid(normalizeTableSpans(html))).toEqual([
			['Block', '', 'c'],
			['', '', 'f'],
			['g', 'h', 'i'],
		]);
	});

	test('preserves multi-<p> cell content and trailing whitespace', () => {
		const html =
			'<table><thead><tr><th><p>HLE</p><p>w/ Tools</p></th><th>x</th></tr></thead>' +
			'<tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
		const out = normalizeTableSpans(html);
		// The <p> structure is left intact for Defuddle/Turndown to flatten.
		expect(out).toContain('<p>HLE</p><p>w/ Tools</p>');
		expect(hasSpanAttrs(out)).toBe(false);
	});

	test('every row ends up with the same number of cells', () => {
		const html =
			'<table><thead><tr><th>A</th><th>B</th><th>C</th><th>D</th></tr></thead><tbody>' +
			'<tr><td>sec</td><td colspan="3"></td></tr>' +
			'<tr><td rowspan="2">r</td><td>1</td><td>2</td><td>3</td></tr>' +
			'<tr><td>4</td><td>5</td><td>6</td></tr>' +
			'</tbody></table>';
		const widths = grid(normalizeTableSpans(html)).map(r => r.length);
		expect(new Set(widths).size).toBe(1);
		expect(widths[0]).toBe(4);
	});

	test('leaves span-free tables and non-table HTML untouched in shape', () => {
		const plain = '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>';
		expect(grid(normalizeTableSpans(plain))).toEqual([['a', 'b']]);

		const noTable = '<p>hello <strong>world</strong></p>';
		expect(normalizeTableSpans(noTable)).toBe(noTable);
	});

	test('handles nested tables independently', () => {
		const html =
			'<table><tbody><tr><td colspan="2">outer</td></tr>' +
			'<tr><td>x</td><td><table><tbody><tr><td colspan="2">inner</td></tr>' +
			'<tr><td>p</td><td>q</td></tr></tbody></table></td></tr></tbody></table>';
		const out = normalizeTableSpans(html);
		expect(hasSpanAttrs(out)).toBe(false);
	});
});
