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

export function mdToOrg(markdown: string): string {
  const src = String(markdown || "").replace(/\r\n?/g, "\n");
  const emitHeading = (rawLevel: number) => "*".repeat(Math.max(1, Math.min(8, rawLevel)));
  const lines = src.split("\n");
  const out: string[]   = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ---- fenced code ----
    const fence = line.match(RE_CODE_FENCE);
    if (fence) {
      const closer = fence[1];
      const lang   = (fence[2] || "").trim();
      const body: string[]   = [];
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
      const body: string[] = [];
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
      out.push(transformTableRow(line));
      // Convert separator to org's `|---+---+---|` form
      const cells = lines[i + 1]
        .replace(/^\s*\|?/, "")
        .replace(/\|?\s*$/, "")
        .split("|");
      const sep = "|" + cells
        .map((c: string) => "-".repeat(Math.max(3, c.trim().length || 3)))
        .join("+") + "|";
      out.push(sep);
      i += 2;
      while (i < lines.length && RE_TABLE_ROW.test(lines[i])) {
        out.push(transformTableRow(lines[i]));
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

function escapeSrcLine(s: string): string {
  // Inside #+BEGIN_SRC/#+END_SRC blocks, leading `*` or `,` must be escaped
  // with a comma per Org's literal-example rules.
  return /^[*,]/.test(s) ? "," + s : s;
}

function transformTableRow(row: string): string {
  // Convert inline markup (links, emphasis, code) inside each table cell.
  // Split on UNescaped pipes so a literal `\|` in a cell isn't treated as a
  // column break; the separator row is handled separately by the caller.
  const parts = row.trim().split(/(?<!\\)\|/);
  return parts
    .map((c: string, idx: number) =>
      idx === 0 || idx === parts.length - 1
        ? c
        : " " + transformInline(c.trim()) + " ")
    .join("|");
}

function transformInline(text: string): string {
  if (!text) return "";

  // 0) protect backslash escapes — must run before emphasis/code so that
  //    `\*` does not get mistaken for italic markers.
  const escapes: string[] = [];
  text = text.replace(/\\([\\`*_{}\[\]()#+\-.!>|~])/g, (_, c: string) => {
    const k = escapes.length;
    escapes.push(c);
    return `\x00E${k}\x00`;
  });

  // 1) inline code: `code`
  const codes: string[] = [];
  text = text.replace(/(`+)([\s\S]*?)\1/g, (_, _b: string, c: string) => {
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
  const refs: string[] = [];
  text = text.replace(
    /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g,
    (_, _alt: string, url: string) => {
      const k = refs.length;
      refs.push(`[[${url}]]`);
      return `\x00R${k}\x00`;
    },
  );
  text = text.replace(
    /\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g,
    (_, label: string, url: string) => {
      const k = refs.length;
      refs.push(`[[${url}][${label}]]`);
      return `\x00R${k}\x00`;
    },
  );
  text = text.replace(/<((?:https?|mailto):[^>\s]+)>/g, (_, url: string) => {
    const k = refs.length;
    refs.push(`[[${url}]]`);
    return `\x00R${k}\x00`;
  });

  // 3) footnote reference [^id] -> [fn:id]
  text = text.replace(/\[\^([^\]\s]+)\]/g, (_, id: string) => `[fn:${id}]`);

  // 4) emphasis — bold via placeholder so italic pass can't collapse it
  const bolds: string[] = [];
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, (_, c: string) => {
    const k = bolds.length;
    bolds.push(c);
    return `\x00B${k}\x00`;
  });
  text = text.replace(/(?<![A-Za-z0-9_])__([^_\n]+?)__(?![A-Za-z0-9_])/g, (_, c: string) => {
    const k = bolds.length;
    bolds.push(c);
    return `\x00B${k}\x00`;
  });
  text = text.replace(/~~([^~\n]+)~~/g, "+$1+");
  text = text.replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, "/$1/");
  text = text.replace(/(?<![_\w])_([^_\n]+?)_(?![_\w])/g, "/$1/");

  // 5) restore placeholders (bold, refs, code, then escapes last so the
  //    revealed literal cannot re-trigger any earlier transform)
  text = text.replace(/\x00B(\d+)\x00/g, (_, k: string) => `*${bolds[+k]}*`);
  text = text.replace(/\x00R(\d+)\x00/g, (_, k: string) => refs[+k]);
  text = text.replace(/\x00C(\d+)\x00/g, (_, k: string) => `~${codes[+k]}~`);
  text = text.replace(/\x00E(\d+)\x00/g, (_, k: string) => escapes[+k]);

  return text;
}
