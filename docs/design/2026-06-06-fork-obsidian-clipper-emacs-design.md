# Design: Re-base org-clipper on a fork of Obsidian Web Clipper

Date: 2026-06-06
Status: Approved (brainstorm) — pending spec review

## Goal

Replace org-clipper's hand-rolled, vanilla-JS browser extension with a **fork of
Obsidian Web Clipper**, adopting its tech stack and architecture 1:1, and swap
only the *output layer* so clips are sent to Emacs/Org instead of an Obsidian
vault. Transport to Emacs is **HTTP only**.

### Why

org-clipper's current extension uses `chrome.scripting.executeScript({files})`
injection plus a vendored Defuddle build. That model is the source of a class of
fragility we just spent real effort on (Trusted-Types hangs on YouTube, the
sync-vs-async `parse()` caption bug, shadow-DOM/clone edge cases). Obsidian
Clipper already solves all of this with declared content scripts + message
passing, a webpack/TypeScript build, and Defuddle as a bundled dependency.
Forking it gives us the proven architecture and a far larger, maintained feature
set for free.

## Tech stack (adopted from Obsidian Clipper, unchanged)

- **TypeScript** (no JSX), **webpack** per-browser production builds
  (Chrome/Firefox/Safari), **SCSS**, **Vitest**.
- **Declared content scripts + message passing** (`content.ts` ↔ `background.ts`)
  — replaces `executeScript`-and-return-a-value injection.
- npm-bundled dependencies: `defuddle`, `dompurify`, `highlight.js`, `linkedom`,
  `lz-string`, `dayjs`, `lucide`; `webextension-polyfill`.
- i18n `_locales`, headless **CLI** (`cli.ts`) and **API** (`api.ts`) builds.

## Scope

- **Kept wholesale** (1:1, no pruning): template engine, content extraction,
  reader, **web highlighter**, **side panel**, **interpreter/LLM**, **CLI + API**,
  **i18n**, settings UI, per-browser builds.
- **Replaced**: the save destination (Obsidian vault / `obsidian://` URI) → Emacs
  over HTTP; the "vault" settings → Emacs transport settings.
- **Dropped**: org-protocol transport (HTTP only this time), the `obsidian://`
  URI builders, and `extension/`'s old vanilla-JS code (superseded — see below).
- **Kept from the old repo**: `emacs/org-clipper.el` (Emacs side) and the
  `md-to-org` conversion logic, ported into the fork as TypeScript.

> The Trusted-Types / `dom-prep` / `executeScript` fixes made earlier were
> patches to the injection model the fork eliminates; they are intentionally
> superseded. Only `md-to-org` and the HTTP transport carry forward.

## Architecture: the output swap (Approach A — convert at the boundary)

Obsidian's template engine is **kept as-is**: templates are authored in Markdown
with `{{variables}}`, filters, and frontmatter *properties*. At save time
`core/popup.ts:1349` (and the CLI twin in `utils/cli-utils.ts`) currently calls:

```
saveToObsidian(fileContent, noteName, path, vault, behavior)
```

where `fileContent` is the rendered *YAML frontmatter + Markdown body*. We
replace that single call with:

```
saveToEmacs(fileContent, noteName, behavior)   // src/utils/emacs-note-creator.ts
```

`saveToEmacs` does three things:

1. **Frontmatter → Org `:PROPERTIES:` drawer.** Parse the rendered YAML
   frontmatter and emit an Org property drawer (`:PROPERTIES: … :END:`) plus the
   standard headline keywords we already use (`:CREATED:`, `:PUBLISHED:` active
   timestamps, etc.). Unknown properties pass through as drawer keys.
2. **Body Markdown → Org.** Port the existing `md-to-org` converter (links,
   images with `#+CAPTION`, code blocks with comma-escaping, blockquotes,
   tables, footnotes, emphasis) to `src/utils/md-to-org.ts` with its Vitest port
   of the current 17 node self-tests.
3. **Dispatch over HTTP.** `POST http://{endpoint}/capture` (default
   `127.0.0.1:17654`) with header `X-Org-Clipper-Token: {token}` and a JSON body
   (contract below). Friendly errors on connection-refused / non-200, surfaced in
   the popup, mirroring today's `transport-http.js`.

### HTTP payload contract (extension → Emacs)

```jsonc
{
  "title":    "<noteName>",
  "content":  "<full Org subtree: heading + :PROPERTIES: drawer + Org body>",
  "template": "<org-capture template key, from settings>",
  "behavior": "create | append | prepend | overwrite | append-daily | prepend-daily",
  "url":      "<source url>",
  "tags":     ["..."]
}
```

The extension renders the **complete** Org (Obsidian model: the client owns
formatting). `emacs/org-clipper.el`'s existing `/capture` handler is updated to
file the pre-rendered `content` under the chosen capture target / `behavior`
(today it assembles the entry itself from discrete fields — that responsibility
moves to the extension).

## Settings swap

Obsidian's *vault* configuration is replaced by **Emacs transport settings** in
`managers/general-settings`:

- `endpoint` (default `127.0.0.1:17654`)
- `token` (shared secret, sent as `X-Org-Clipper-Token`)
- default org-capture `template` key
- default `tags`

Template `behavior` (create / append / prepend / daily / overwrite) is preserved
and forwarded to Emacs. No transport selector (HTTP only). The vault picker,
`obsidian://` legacy-mode, and "silent open" options are removed.

## Manifest / permissions

- Rebrand name/description/icons to org-clipper across `manifest.{chrome,firefox,safari}.json`.
- `host_permissions`: `http://127.0.0.1/*`, `http://localhost/*` (HTTP transport)
  plus the page-access permissions Obsidian already declares for clipping.
- Remove `obsidian://` protocol handling.

## Licensing

Obsidian Web Clipper is MIT (© 2024 Obsidian). Keep its `LICENSE` and copyright,
add org-clipper's own notice, and credit the fork in `README`.

## Testing

- Port the `md-to-org` self-tests to Vitest (17 cases) + add frontmatter→drawer
  cases.
- Vitest unit test for `saveToEmacs` (mock `fetch`): correct URL, token header,
  payload shape, error handling — mirroring the current `transport-http.js`
  self-tests.
- Keep Obsidian's existing Vitest suite green.
- Manual end-to-end: `M-x org-clipper-start`, clip a page (incl. a YouTube
  transcript), confirm the Org entry lands.

## Phasing (for the implementation plan)

1. Stand up the forked build in-repo, green, rebranded (name/icons/manifest).
2. Port `md-to-org` → TS + Vitest.
3. `emacs-note-creator.ts` (`saveToEmacs`) + HTTP transport; unit-tested.
4. Swap the call sites (`popup.ts`, `cli-utils.ts`); rip out `obsidian://`/vault.
5. Settings swap (Emacs transport config).
6. Update `emacs/org-clipper.el` `/capture` to file pre-rendered Org; verify e2e.
7. Prune dead Obsidian-isms; docs/README.

## Open questions / risks

- **Property mapping fidelity.** Obsidian frontmatter is free-form; the YAML→Org
  drawer mapping must handle lists, dates, and nested values predictably. Start
  with scalars + lists; dates use the existing active-timestamp rules.
- **`behavior` semantics in Emacs.** `append-daily`/`prepend-daily` need a
  daily-note target on the Emacs side; map to a configurable capture target.
- **Bundle size / build time.** Inherit Obsidian's full feature set → larger
  build than today's no-build extension. Acceptable per the 1:1 decision.
- **Repo history.** Forking drops a large vendored codebase in; record provenance
  (upstream commit) in the README for future rebases.
