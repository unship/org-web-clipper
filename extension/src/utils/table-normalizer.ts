// Expand colspan/rowspan in HTML tables into discrete 1x1 cells.
//
// Why: Defuddle's Markdown converter bails out the moment ANY cell in a table
// carries a `colspan`/`rowspan` attribute — it dumps the raw <table> HTML
// instead of a Markdown pipe-table (see node_modules/defuddle/dist/markdown.js,
// the `hasComplexStructure` branch). That raw HTML then survives into the
// Org/Markdown clip verbatim, which is exactly the bug seen on pages like
// https://z.ai/blog/glm-5.2 whose tables use `<td colspan="8">` section rows.
//
// Org (and Markdown) have no colspan/rowspan concept anyway, so the faithful
// representation is a rectangular grid: a spanned cell keeps its value in its
// top-left position and every position it used to cover becomes an empty cell.
// Once no cell has a span attribute, Defuddle takes its "simple table" path and
// emits a real pipe-table, which md-to-org then renders as an Org table.

const MAX_SPAN = 1000; // HTML caps colspan/rowspan at 1000; guard against abuse.

function clampSpan(raw: string | null): number {
	const n = parseInt(raw || '', 10);
	if (!Number.isFinite(n) || n < 1) return 1;
	return Math.min(n, MAX_SPAN);
}

// Rows that belong directly to `table` — i.e. excluding rows of nested tables,
// regardless of whether they sit under <thead>/<tbody>/<tfoot> or directly.
function directRows(table: Element): Element[] {
	return Array.from(table.querySelectorAll('tr')).filter(tr => {
		let p: Element | null = tr.parentElement;
		while (p) {
			if (p.tagName === 'TABLE') return p === table;
			p = p.parentElement;
		}
		return false;
	});
}

function rowCells(row: Element): Element[] {
	return Array.from(row.children).filter(
		c => c.tagName === 'TD' || c.tagName === 'TH'
	);
}

interface Carry { remaining: number; tag: string }

function expandTable(table: Element, doc: Document): void {
	const rows = directRows(table);
	if (!rows.length) return;

	// carry[col]: a rowspan started above is still occupying this column for
	// `remaining` more rows; fillers use `tag` (th/td) to match the origin cell.
	const carry: (Carry | undefined)[] = [];
	const mkEmpty = (tag: string) => doc.createElement(tag);

	for (const row of rows) {
		const cells = rowCells(row);
		const ordered: Element[] = [];
		let col = 0;

		const consumeCarry = () => {
			while (carry[col] && carry[col]!.remaining > 0) {
				ordered.push(mkEmpty(carry[col]!.tag));
				carry[col]!.remaining -= 1;
				col += 1;
			}
		};

		for (const cell of cells) {
			consumeCarry();
			const colspan = clampSpan(cell.getAttribute('colspan'));
			const rowspan = clampSpan(cell.getAttribute('rowspan'));
			const tag = cell.tagName === 'TH' ? 'th' : 'td';

			// The real cell occupies the top-left of its former span.
			cell.removeAttribute('colspan');
			cell.removeAttribute('rowspan');
			ordered.push(cell);
			if (rowspan > 1) carry[col] = { remaining: rowspan - 1, tag };
			col += 1;

			// Columns the colspan used to cover become empty cells (each also
			// carrying the rowspan downward if there was one).
			for (let k = 1; k < colspan; k++) {
				ordered.push(mkEmpty(tag));
				if (rowspan > 1) carry[col] = { remaining: rowspan - 1, tag };
				col += 1;
			}
		}

		// Rowspans that start in columns to the right of this row's last cell
		// still need a filler here.
		for (; col < carry.length; col++) {
			if (carry[col] && carry[col]!.remaining > 0) {
				ordered.push(mkEmpty(carry[col]!.tag));
				carry[col]!.remaining -= 1;
			}
		}

		// Rebuild the row from the grid-ordered cells (drops inter-cell
		// whitespace text nodes, which Turndown ignores anyway).
		while (row.firstChild) row.removeChild(row.firstChild);
		for (const c of ordered) row.appendChild(c);
	}
}

// Parse `html`, expand spans in every (possibly nested) table, return the
// serialized HTML. No-ops gracefully when there are no tables or no DOM.
export function normalizeTableSpans(html: string): string {
	if (!html || html.indexOf('<table') === -1) return html;
	if (typeof DOMParser === 'undefined') return html;

	let doc: Document;
	try {
		doc = new DOMParser().parseFromString(html, 'text/html');
	} catch {
		return html;
	}

	const tables = Array.from(doc.querySelectorAll('table'));
	if (!tables.length) return html;

	for (const table of tables) expandTable(table, doc);
	return doc.body.innerHTML;
}
