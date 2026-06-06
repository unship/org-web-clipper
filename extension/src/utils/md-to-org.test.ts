import { describe, it, expect } from 'vitest';
import { mdToOrg } from './md-to-org';

describe('mdToOrg', () => {
	it('headings + paragraph', () => {
		expect(mdToOrg("# Title\n\n## Sub\n\nbody")).toBe("* Title\n\n** Sub\n\nbody\n");
	});

	it('unordered + ordered lists with indent', () => {
		expect(mdToOrg("- a\n- b\n  - c\n\n1. one\n2. two")).toBe("- a\n- b\n  - c\n\n1. one\n2. two\n");
	});

	it('inline image inside a paragraph drops alt (org inline-previews it)', () => {
		expect(
			mdToOrg("See [docs](https://example.com) and ![logo](https://example.com/img.png)."),
		).toBe("See [[https://example.com][docs]] and [[https://example.com/img.png]].\n");
	});

	it('block-level image emits #+CAPTION above [[url]] (alt preserved)', () => {
		expect(mdToOrg("![the scratch buffer](https://x/scratch.webp)")).toBe(
			"#+CAPTION: the scratch buffer\n[[https://x/scratch.webp]]\n",
		);
	});

	it('markdown title= wins over alt for the #+CAPTION value', () => {
		expect(mdToOrg('![alt-fallback](https://x/img.png "real title")')).toBe(
			"#+CAPTION: real title\n[[https://x/img.png]]\n",
		);
	});

	it('block-level image with empty alt: no #+CAPTION line', () => {
		expect(mdToOrg("![](https://x/no-alt.gif)")).toBe("[[https://x/no-alt.gif]]\n");
	});

	it('block image between paragraphs stays on its own block', () => {
		expect(mdToOrg("Para 1.\n\n![cap](https://x/a.png)\n\nPara 2.")).toBe(
			"Para 1.\n\n#+CAPTION: cap\n[[https://x/a.png]]\n\nPara 2.\n",
		);
	});

	it('inline emphasis + code + strikethrough', () => {
		expect(mdToOrg("This is **bold** and *italic* and `code` and ~~gone~~.")).toBe(
			"This is *bold* and /italic/ and ~code~ and +gone+.\n",
		);
	});

	it('fenced code with language', () => {
		expect(mdToOrg("```js\nconst x = 1;\n```")).toBe(
			"#+BEGIN_SRC js\nconst x = 1;\n#+END_SRC\n",
		);
	});

	it('blockquote (soft-broken lines collapse to one paragraph)', () => {
		expect(mdToOrg("> first\n> second")).toBe(
			"#+BEGIN_QUOTE\nfirst second\n#+END_QUOTE\n",
		);
	});

	it('horizontal rule', () => {
		expect(mdToOrg("foo\n\n---\n\nbar")).toBe("foo\n\n-----\n\nbar\n");
	});

	it('footnotes (ref + def)', () => {
		expect(mdToOrg("See[^1] for context.\n\n[^1]: A footnote.")).toBe(
			"See[fn:1] for context.\n\n[fn:1] A footnote.\n",
		);
	});

	it('paragraph passthrough', () => {
		expect(mdToOrg("Heading shifted")).toBe("Heading shifted\n");
	});

	it('heading levels emitted verbatim (Emacs normalizes)', () => {
		expect(mdToOrg("## A\n\n#### Deep")).toBe("** A\n\n**** Deep\n");
	});

	it('backslash-escaped asterisks unescaped', () => {
		expect(mdToOrg("Code with \\*escaped\\* asterisks.")).toBe(
			"Code with *escaped* asterisks.\n",
		);
	});

	it('src-block leading * and , are comma-escaped', () => {
		expect(mdToOrg("```\nplain\n,nothing-special\n*star line\n```")).toBe(
			"#+BEGIN_SRC\nplain\n,,nothing-special\n,*star line\n#+END_SRC\n",
		);
	});

	it('inline markup inside table cells is converted (links, emphasis, code)', () => {
		expect(
			mdToOrg(
				"| Name | Ref |\n| --- | --- |\n| Docs | [site](https://example.com) |\n| Emph | **hi** `c` |",
			),
		).toBe(
			"| Name | Ref |\n|---+---|\n| Docs | [[https://example.com][site]] |\n| Emph | *hi* ~c~ |\n",
		);
	});
});
