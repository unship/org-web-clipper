# org-clipper Phase 4 — Non-destructive clip + reading mode (extension)

- **Status:** Draft for review
- **Date:** 2026-06-03
- **Scope:** `extension/` only — `content-extract.js`, `background.js`, `popup.{html,js}`, `manifest.json`, and a new `reader.js`. No `emacs/` changes.
- **Reference:** `kepano/obsidian-clipper` (the upstream this project mirrors).

## 1. Goals

- **Clipping must never alter the visible page.** Today, clicking *Clip page* runs Defuddle on the live `document` and the page's displayed content visibly changes. Fix it so extraction is read-only on the page.
- **Add a reading mode** — a clean, distraction-free article view, toggled on/off, that *deliberately* changes the display (a separate feature from clipping).
- **Clip from within reading mode** — a `[Clip]` control in the reader produces the same Org output as *Clip page*.

### Non-goals

- No `emacs/` changes — the Org payload and output are unchanged, so the existing ERT suite is the regression guard.
- No reader-specific persistence, annotation, theming UI, or per-site settings (YAGNI).
- No change to the transports (org-protocol / HTTP) or the image-attachment pipeline.

## 2. Background — why the page changes today

Clip path: `popup → CLIP_TAB → background.extractFromTab → executeScript([lib/defuddle.js, src/content-extract.js])`, and `content-extract.js` calls:

```js
new Defuddle(document, { markdown:true, url:location.href, standardize:true, removeImages:false }).parse();
```

The only page-side code is Defuddle + this wrapper, so the mutation originates inside Defuddle's `parse()` over the **live `document`**. The vendored bundle is `defuddle 0.18.1` (`index.full.js`) — the same build obsidian-clipper uses, which *does* clone internally (`w = this.doc.cloneNode(true)`) and applies content/mobile-style mutations to the clone. But `parse()` still **reads the live doc** in `flattenShadowRoots(this.doc, w)` and `_evaluateMediaQueries(this.doc)`; the observed leak most plausibly comes from shadow-root flattening over the live tree, combined with our sync `parse()` + `standardize:true`/`markdown:true` options (obsidian-clipper instead calls `parseAsync()` with minimal options). The exact line is not load-bearing for the fix — see §4.

The reference's **reader** mode mutates the live DOM in place and exits by `window.location.reload()`; its **clip** path passes the live doc but stays safe because Defuddle clones internally. We diverge from both by (a) leaking on clip and (b) wanting a *non-destructive* reader (user's choice).

## 3. Architecture & data flow

```
 ┌─ Clip page (popup) ─┐     ┌─ Reading mode (popup btn / Alt+R) ─┐
 │ CLIP_TAB            │     │ TOGGLE_READER / command            │
 └─────────┬───────────┘     └──────────────┬─────────────────────┘
           ▼                                ▼
 background.extractFromTab          background.toggleReaderInTab
  executeScript:                     executeScript: [defuddle, reader.js] (idempotent)
   [defuddle, content-extract]       tabs.sendMessage {toggleReader}
           │                                ▼
           ▼                         reader.js (content script)
  Defuddle on a CLONE  ◄── §4 ──►     overlay absent? → build iframe#org-clipper-reader
  (live page untouched)               overlay present? → remove + restore scroll
           │                                │  Defuddle on a CLONE → clean HTML
           ▼                                ▼
  md→org → transport               full-viewport iframe over the intact page
                                    floating [Clip] → CLIP_TAB (sender.tab.id) → same path
```

Key property: the reader overlay sits **over** an intact page, so *Clip from reader* reuses the normal clip pipeline (Defuddle on a clone) and yields an identical payload. No cached-parse coordination is needed.

## 4. The non-destructive clip fix (`content-extract.js`)

Extract from a **detached clone** so nothing Defuddle does can touch the live page:

```js
const clone = document.cloneNode(true);
clone.getElementById("org-clipper-reader")?.remove();        // never clip our own overlay
Object.defineProperty(clone, "URL", { value: location.href, configurable: true });
const r = new Defuddle(clone, { markdown:true, url:location.href, standardize:true, removeImages:false }).parse();
```

**Trade-off (accepted):** a detached clone is not rendered, so Defuddle's layout-dependent heuristics degrade — `_evaluateMediaQueries`/mobile-styles see no live stylesheets, and small-image (tracking-pixel) filtering loses rendered dimensions. Effect: occasional junk images and no mobile-style normalization. This is exactly how the reference's reader extracts, and the payoff is the page never mutates. If clip quality regresses, a later refinement can run *only* the image-size check against the live doc and pass the result in — out of scope here.

## 5. Reading mode (`reader.js` + overlay)

A content script injected on demand. **Overlay realization: a full-viewport same-origin `iframe`** (`srcdoc`), which the content script owns directly.

**Enter** (no overlay present):
1. `const clone = document.cloneNode(true); clone.getElementById("org-clipper-reader")?.remove();` then Defuddle with `markdown:false` → cleaned **HTML** (`r.content`) + title.
2. Create `iframe#org-clipper-reader`, styled `position:fixed; inset:0; width:100vw; height:100vh; border:0; z-index:2147483647`, appended to `document.documentElement`.
3. `srcdoc` is a **static shell** (no inline `<script>`): `<base href="<location.href>" target="_top">`, `<meta viewport>`, inlined `READER_CSS`, an empty `.oc-reader-bar` with `[Clip]`/`[Exit]` buttons, and an empty `<article>`.
4. On the iframe's `load`, the content script reaches `iframe.contentDocument` (same-origin — `srcdoc` inherits the page origin), sets `article.innerHTML = r.content` (**innerHTML does not execute scripts** — safe), and wires the two buttons **directly** (no `postMessage`, no inline script — sidesteps page CSP).
5. Lock page scroll: save and set `document.documentElement.style.overflow = "hidden"`.

The original DOM stays intact underneath; page scripts keep running but are visually covered.

**Exit** (`[Exit]`, `Esc`, or toggle again): remove `#org-clipper-reader`, restore saved `overflow`. Instant, **no reload**, scroll preserved.

**Clip** (`[Clip]`): `chrome.runtime.sendMessage({ type:"CLIP_TAB", tags:[], selectionOnly:false })`. Background applies `cfg.defaultTags` and runs the normal clip (Defuddle on a clone of the intact page). A small toast in the overlay reports success/error.

**Reader CSS:** inlined `READER_CSS` string — `color-scheme: light dark` + `prefers-color-scheme` for dark, a centered `max-width: ~70ch` column, readable system typography, responsive images. Lives in the `srcdoc`; `chrome.scripting.insertCSS` cannot reach iframe content.

**Idempotency:** `reader.js` guards re-injection via `window.__orgClipperReader`; first injection installs the controller + `toggleReader` message listener, later injections/messages just toggle.

**Fallback:** if a site's CSP blocks `srcdoc` iframes, a closed **shadow-DOM** overlay (host `<div>` + `attachShadow({mode:"closed"})` + scoped `<style>`) is a drop-in replacement with identical non-destructive/instant-exit behavior and direct event wiring. Chosen at implementation time only if the iframe proves problematic.

## 6. Triggers & messaging

- **Popup:** a new **"Reading mode"** button in `popup.html` beside *Clip page*; `popup.js` sends `{type:"TOGGLE_READER", tabId}` then `window.close()`.
- **Keyboard:** new `toggle-reader` command (suggested `Alt+R`, user-rebindable at `chrome://extensions/shortcuts`). `background.js` handles `chrome.commands.onCommand`, resolves the active tab, and calls `toggleReaderInTab`.
- **`toggleReaderInTab(tabId)`** (`background.js`): `executeScript({ files:["lib/defuddle.js","src/reader.js"] })` (idempotent) then `tabs.sendMessage(tabId, {type:"toggleReader"})`.
- **`CLIP_TAB` handler:** accept `const tabId = msg.tabId ?? sender.tab?.id` so reader-initiated clips (which have no `msg.tabId`) work.

## 7. Manifest changes

Add one command; **no new permissions** (`activeTab` + `scripting` + `host_permissions:["*://*/*"]` already cover injection):

```json
"commands": {
  "_execute_action": { "description": "Open the org-clipper popup" },
  "clip-page":       { "description": "Clip the current page to Org without opening the popup" },
  "toggle-reader":   { "suggested_key": { "default": "Alt+R" }, "description": "Toggle reading mode" }
}
```

Three commands — within Chrome's 4-suggested-key limit.

## 8. Files

| File | Change |
| --- | --- |
| `extension/src/reader.js` | **new** — overlay controller (build/teardown, wire `[Clip]`/`[Exit]`, toggle listener, idempotency, toast) |
| `extension/src/content-extract.js` | clone-before-Defuddle; strip `#org-clipper-reader` from the clone |
| `extension/src/background.js` | `toggle-reader` command, `TOGGLE_READER` message, `toggleReaderInTab`, `CLIP_TAB` accepts `sender.tab.id` |
| `extension/src/popup.html` | "Reading mode" button |
| `extension/src/popup.js` | button → `TOGGLE_READER` + close |
| `extension/manifest.json` | `toggle-reader` command |

## 9. Testing

- **Emacs:** unchanged → existing ERT suite must stay green (regression guard).
- **JS unit:** factor the DOM-free **reader shell builder** (`buildReaderShellHtml({ baseUrl, css })`) into a module exercised by a Node `assertEq` self-test in the repo's existing style (`md-to-org.js`): assert it contains `<base href="…" target="_top">`, the `[Clip]`/`[Exit]` controls, and an empty `<article>`, and that it embeds **no** `<script>`. (Content scripts are classic, non-module; the shared helper must be loadable both as a classic include and an ES import — resolved in the plan.)
- **DOM integration (manual, in-browser):** clip leaves the page visually unchanged; reading mode overlays a clean article; `[Exit]`/`Esc`/re-toggle restores instantly with scroll intact; `[Clip]` from reader produces the same Org entry as *Clip page*; `Alt+R` toggles. Verified via the run/verify skills, since the repo has no jsdom/browser harness.

## 10. Open trade-offs (carried from design)

1. **Overlay = iframe** (chosen); shadow-DOM fallback documented in §5.
2. Reader `[Clip]` uses **default tags** (no in-overlay tag prompt); *selection only* remains a popup-clip option.
3. Clone-based extraction's heuristic degradation (§4) is accepted for v1.
