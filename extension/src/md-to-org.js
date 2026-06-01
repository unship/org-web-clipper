// Markdown -> Org-mode converter.
//
// Targets the markdown Defuddle emits (mostly CommonMark, no significant
// inline HTML). Block-based pass over lines, then an inline pass per block.
//
// Public API:
//   mdToOrg(markdown: string): string
//     Heading levels are emitted verbatim (a `##' becomes `**'); Emacs owns
//     level normalization (org-clipper--relevel-body) when filing the clip.

const RE_CODE_FENCE   = /^(```|~~~)([^\n`~]*)$/;
const RE_HR           = /^[ ]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_ATX_HEADING  = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const RE_SETEXT_H1    = /^=+\s*$/;
const RE_SETEXT_H2    = /^-+\s*$/;
const RE_OL_ITEM      = /^(\s*)(\d+)([.)])\s+(.*)$/;
const RE_UL_ITEM      = /^(\s*)[-*+]\s+(.*)$/;
const RE_BLOCKQUOTE   = /^>\s?(.*)$/;
const RE_TABLE_ROW    = /^\s*\|.*\|\s*$/;
const RE_TABLE_SEP    = /^\s*\|?\s*:?-+:?(\s*\|\s*:?-+:?)*\s*\|?\s*$/;
const RE_FOOTNOTE_DEF = /^\[\^([^\]]+)\]:\s*(.*)$/;
// A line whose only content is one markdown image (optional surrounding
// whitespace). We treat these as block-level images so we can attach a
// `#+CAPTION:' line above them, preserving the alt text in a way Org
// natively recognises and that HTML/LaTeX exports honour.
const RE_BLOCK_IMAGE = /^\s*!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)\s*$/;

export function mdToOrg(markdown, options = {}) {
  const src = String(markdown || "").replace(/\r\n?/g, "\n");
  const emitHeading = (rawLevel) => "*".repeat(Math.max(1, Math.min(8, rawLevel)));
  const lines = src.split("\n");
  const out   = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ---- fenced code ----
    const fence = line.match(RE_CODE_FENCE);
    if (fence) {
      const closer = fence[1];
      const lang   = (fence[2] || "").trim();
      const body   = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(closer)) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      out.push(`#+BEGIN_SRC${lang ? " " + lang : ""}`);
      for (const b of body) out.push(escapeSrcLine(b));
      out.push("#+END_SRC");
      continue;
    }

    // ---- horizontal rule ----
    if (RE_HR.test(line)) {
      out.push("-----");
      i++;
      continue;
    }

    // ---- ATX heading ----
    const atx = line.match(RE_ATX_HEADING);
    if (atx) {
      out.push(emitHeading(atx[1].length) + " " + transformInline(atx[2]));
      i++;
      continue;
    }

    // ---- setext heading ----
    if (i + 1 < lines.length && line.trim() && RE_SETEXT_H1.test(lines[i + 1])) {
      out.push(emitHeading(1) + " " + transformInline(line.trim()));
      i += 2;
      continue;
    }
    if (
      i + 1 < lines.length &&
      line.trim() &&
      RE_SETEXT_H2.test(lines[i + 1]) &&
      !RE_HR.test(lines[i + 1])
    ) {
      out.push(emitHeading(2) + " " + transformInline(line.trim()));
      i += 2;
      continue;
    }

    // ---- blockquote ----
    if (RE_BLOCKQUOTE.test(line)) {
      const body = [];
      while (i < lines.length && RE_BLOCKQUOTE.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push("#+BEGIN_QUOTE");
      out.push(mdToOrg(body.join("\n")).replace(/\n+$/, ""));
      out.push("#+END_QUOTE");
      continue;
    }

    // ---- table ----
    if (
      RE_TABLE_ROW.test(line) &&
      i + 1 < lines.length &&
      RE_TABLE_SEP.test(lines[i + 1])
    ) {
      out.push(line.trim());
      // Convert separator to org's `|---+---+---|` form
      const cells = lines[i + 1]
        .replace(/^\s*\|?/, "")
        .replace(/\|?\s*$/, "")
        .split("|");
      const sep = "|" + cells
        .map(c => "-".repeat(Math.max(3, c.trim().length || 3)))
        .join("+") + "|";
      out.push(sep);
      i += 2;
      while (i < lines.length && RE_TABLE_ROW.test(lines[i])) {
        out.push(lines[i].trim());
        i++;
      }
      continue;
    }

    // ---- lists ----
    if (RE_UL_ITEM.test(line) || RE_OL_ITEM.test(line)) {
      while (
        i < lines.length &&
        (RE_UL_ITEM.test(lines[i]) ||
          RE_OL_ITEM.test(lines[i]) ||
          /^\s{2,}\S/.test(lines[i]))
      ) {
        const ul = lines[i].match(RE_UL_ITEM);
        const ol = lines[i].match(RE_OL_ITEM);
        if (ul) {
          out.push(`${ul[1]}- ${transformInline(ul[2])}`);
        } else if (ol) {
          out.push(`${ol[1]}${ol[2]}. ${transformInline(ol[4])}`);
        } else {
          out.push(transformInline(lines[i]));
        }
        i++;
      }
      continue;
    }

    // ---- footnote definition ----
    const fn = line.match(RE_FOOTNOTE_DEF);
    if (fn) {
      out.push(`[fn:${fn[1]}] ${transformInline(fn[2])}`);
      i++;
      continue;
    }

    // ---- block-level image (own line) ----
    // Emit as `#+CAPTION: alt\n[[url]]' so Org preserves the alt text as
    // a real caption (used by overlays + HTML/LaTeX export) while still
    // letting the bare `[[url]]' line be picked up by inline-image
    // preview.  Markdown's optional title="..." wins over alt for caption
    // if present (it usually carries the "human" caption).
    const blockImg = line.match(RE_BLOCK_IMAGE);
    if (blockImg) {
      const alt = (blockImg[3] || blockImg[1] || "").trim();
      const url = blockImg[2];
      if (alt) out.push(`#+CAPTION: ${alt}`);
      out.push(`[[${url}]]`);
      i++;
      continue;
    }

    // ---- blank line ----
    if (!line.trim()) {
      out.push("");
      i++;
      continue;
    }

    // ---- paragraph ----
    const para = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !RE_ATX_HEADING.test(lines[i]) &&
      !RE_CODE_FENCE.test(lines[i]) &&
      !RE_HR.test(lines[i]) &&
      !RE_BLOCKQUOTE.test(lines[i]) &&
      !RE_UL_ITEM.test(lines[i]) &&
      !RE_OL_ITEM.test(lines[i]) &&
      !RE_FOOTNOTE_DEF.test(lines[i]) &&
      !RE_BLOCK_IMAGE.test(lines[i]) &&
      !(i + 1 < lines.length && RE_SETEXT_H1.test(lines[i + 1])) &&
      !(i + 1 < lines.length && RE_SETEXT_H2.test(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(transformInline(para.join(" ").replace(/[ \t]+/g, " ").trim()));
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/^\n+|\n+$/g, "") + "\n";
}

function escapeSrcLine(s) {
  // Inside #+BEGIN_SRC/#+END_SRC blocks, leading `*` or `,` must be escaped
  // with a comma per Org's literal-example rules.
  return /^[*,]/.test(s) ? "," + s : s;
}

function transformInline(text) {
  if (!text) return "";

  // 0) protect backslash escapes — must run before emphasis/code so that
  //    `\*` does not get mistaken for italic markers.
  const escapes = [];
  text = text.replace(/\\([\\`*_{}\[\]()#+\-.!>|~])/g, (_, c) => {
    const k = escapes.length;
    escapes.push(c);
    return `\x00E${k}\x00`;
  });

  // 1) inline code: `code`
  const codes = [];
  text = text.replace(/(`+)([\s\S]*?)\1/g, (_, _b, c) => {
    const k = codes.length;
    codes.push(c);
    return `\x00C${k}\x00`;
  });

  // 2) images and links (resolve to org and stash, so emphasis transforms
  //    can't touch URLs containing _ * etc.)
  //
  // Images: always emit as plain `[[url]]` (no description). Org only
  // inline-previews bare image links — the `[[url][alt]]' form requires
  // an explicit C-u prefix to `org-toggle-inline-images', which most
  // users will never discover. Dropping the alt text is the price for
  // clips that visually look right out of the box.
  const refs = [];
  text = text.replace(
    /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g,
    (_, _alt, url) => {
      const k = refs.length;
      refs.push(`[[${url}]]`);
      return `\x00R${k}\x00`;
    },
  );
  text = text.replace(
    /\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g,
    (_, label, url) => {
      const k = refs.length;
      refs.push(`[[${url}][${label}]]`);
      return `\x00R${k}\x00`;
    },
  );
  text = text.replace(/<((?:https?|mailto):[^>\s]+)>/g, (_, url) => {
    const k = refs.length;
    refs.push(`[[${url}]]`);
    return `\x00R${k}\x00`;
  });

  // 3) footnote reference [^id] -> [fn:id]
  text = text.replace(/\[\^([^\]\s]+)\]/g, (_, id) => `[fn:${id}]`);

  // 4) emphasis — bold via placeholder so italic pass can't collapse it
  const bolds = [];
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, (_, c) => {
    const k = bolds.length;
    bolds.push(c);
    return `\x00B${k}\x00`;
  });
  text = text.replace(/(?<![A-Za-z0-9_])__([^_\n]+?)__(?![A-Za-z0-9_])/g, (_, c) => {
    const k = bolds.length;
    bolds.push(c);
    return `\x00B${k}\x00`;
  });
  text = text.replace(/~~([^~\n]+)~~/g, "+$1+");
  text = text.replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, "/$1/");
  text = text.replace(/(?<![_\w])_([^_\n]+?)_(?![_\w])/g, "/$1/");

  // 5) restore placeholders (bold, refs, code, then escapes last so the
  //    revealed literal cannot re-trigger any earlier transform)
  text = text.replace(/\x00B(\d+)\x00/g, (_, k) => `*${bolds[+k]}*`);
  text = text.replace(/\x00R(\d+)\x00/g, (_, k) => refs[+k]);
  text = text.replace(/\x00C(\d+)\x00/g, (_, k) => `~${codes[+k]}~`);
  text = text.replace(/\x00E(\d+)\x00/g, (_, k) => escapes[+k]);

  return text;
}

// ---------- self-tests ----------
// Run with `node src/md-to-org.js` from the extension directory.

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) runTests();

function assertEq(actual, expected, label) {
  const a = String(actual).replace(/\n+$/, "");
  const e = String(expected).replace(/\n+$/, "");
  if (a !== e) {
    console.error(`FAIL: ${label}`);
    console.error("--- expected ---");
    console.error(e);
    console.error("--- actual ---");
    console.error(a);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${label}`);
  }
}

function runTests() {
  assertEq(
    mdToOrg("# Title\n\n## Sub\n\nbody"),
    "* Title\n\n** Sub\n\nbody",
    "headings + paragraph",
  );

  assertEq(
    mdToOrg("- a\n- b\n  - c\n\n1. one\n2. two"),
    "- a\n- b\n  - c\n\n1. one\n2. two",
    "unordered + ordered lists with indent",
  );

  assertEq(
    mdToOrg(
      "See [docs](https://example.com) and ![logo](https://example.com/img.png).",
    ),
    "See [[https://example.com][docs]] and [[https://example.com/img.png]].",
    "inline image inside a paragraph drops alt (org inline-previews it)",
  );

  assertEq(
    mdToOrg("![the scratch buffer](https://x/scratch.webp)"),
    "#+CAPTION: the scratch buffer\n[[https://x/scratch.webp]]",
    "block-level image emits #+CAPTION above [[url]] (alt preserved)",
  );

  assertEq(
    mdToOrg('![alt-fallback](https://x/img.png "real title")'),
    "#+CAPTION: real title\n[[https://x/img.png]]",
    "markdown title= wins over alt for the #+CAPTION value",
  );

  assertEq(
    mdToOrg("![](https://x/no-alt.gif)"),
    "[[https://x/no-alt.gif]]",
    "block-level image with empty alt: no #+CAPTION line",
  );

  assertEq(
    mdToOrg("Para 1.\n\n![cap](https://x/a.png)\n\nPara 2."),
    "Para 1.\n\n#+CAPTION: cap\n[[https://x/a.png]]\n\nPara 2.",
    "block image between paragraphs stays on its own block",
  );

  assertEq(
    mdToOrg("This is **bold** and *italic* and `code` and ~~gone~~."),
    "This is *bold* and /italic/ and ~code~ and +gone+.",
    "inline emphasis + code + strikethrough",
  );

  assertEq(
    mdToOrg("```js\nconst x = 1;\n```"),
    "#+BEGIN_SRC js\nconst x = 1;\n#+END_SRC",
    "fenced code with language",
  );

  assertEq(
    mdToOrg("> first\n> second"),
    "#+BEGIN_QUOTE\nfirst second\n#+END_QUOTE",
    "blockquote (soft-broken lines collapse to one paragraph)",
  );

  assertEq(
    mdToOrg("foo\n\n---\n\nbar"),
    "foo\n\n-----\n\nbar",
    "horizontal rule",
  );

  assertEq(
    mdToOrg("See[^1] for context.\n\n[^1]: A footnote."),
    "See[fn:1] for context.\n\n[fn:1] A footnote.",
    "footnotes (ref + def)",
  );

  assertEq(
    mdToOrg("Heading shifted", { headingShift: 0 }),
    "Heading shifted",
    "paragraph passthrough",
  );

  assertEq(
    mdToOrg("## A\n\n#### Deep"),
    "** A\n\n**** Deep",
    "heading levels emitted verbatim (Emacs normalizes)",
  );

  assertEq(
    mdToOrg("Code with \\*escaped\\* asterisks."),
    "Code with *escaped* asterisks.",
    "backslash-escaped asterisks unescaped",
  );

  assertEq(
    mdToOrg("```\nplain\n,nothing-special\n*star line\n```"),
    "#+BEGIN_SRC\nplain\n,,nothing-special\n,*star line\n#+END_SRC",
    "src-block leading * and , are comma-escaped",
  );

  console.log("\nall md-to-org tests done");
}
