# Fork Obsidian Web Clipper → Emacs (HTTP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-base org-clipper's browser extension on a fork of Obsidian Web Clipper (TypeScript + webpack + declared content scripts + bundled Defuddle), swapping only the output layer so a clip is rendered to Org in the extension and POSTed to Emacs over HTTP.

**Architecture:** Keep Obsidian's Markdown template engine untouched. At the single save call site we replace `saveToObsidian(...)` with `saveToEmacs(...)`, which turns the template's structured properties into an Org `:PROPERTIES:` drawer, converts the Markdown body to Org (ported `md-to-org`), assembles a full Org subtree, and `POST`s it to `http://127.0.0.1:17654/capture` with an `X-Org-Clipper-Token` header. The existing `emacs/org-clipper.el` HTTP handler is updated to file the pre-rendered Org subtree.

**Tech Stack:** TypeScript, webpack, Vitest, SCSS, `webextension-polyfill`, Defuddle (npm), `dompurify`, `dayjs` — all inherited from Obsidian Web Clipper. Emacs Lisp on the receiving side.

---

## Source-of-truth references (read before starting)

- Upstream fork source (sibling checkout): `/Users/liyanan/go/src/github.com/ed/obsidian-clipper`
- Swap call site: `obsidian-clipper/src/core/popup.ts:1312` (`handleClipObsidian`), save at `:1349`.
- Output layer being replaced: `obsidian-clipper/src/utils/obsidian-note-creator.ts` (`saveToObsidian`), CLI twin `obsidian-clipper/src/utils/cli-utils.ts:~80`.
- Property/frontmatter source: `obsidian-clipper/src/utils/shared.ts` `generateFrontmatter(properties, propertyTypes)`; types `Property`, `Template['behavior']` in `obsidian-clipper/src/types/types.ts`.
- Org logic to port: `org-clipper/extension/src/md-to-org.js` (438 lines, 17 self-tests) and `org-clipper/extension/src/transport-http.js` (`sendCapture`).
- Emacs receiver: `org-clipper/emacs/org-clipper.el` — `org-clipper--insert-clip`, `org-clipper--format-entry`, `org-clipper--relevel-body`, the http handler, and `org-clipper-target-headline`.

## File Structure (what changes)

- **Imported wholesale** (the fork): `obsidian-clipper/*` → `org-clipper/extension/` (replacing today's vanilla-JS `extension/`). Keep `package.json`, `webpack.config.js`, `tsconfig.json`, `src/`, `_locales/`, manifests, `scripts/`.
- **New (we author):**
  - `extension/src/utils/md-to-org.ts` — Markdown→Org (port).
  - `extension/src/utils/org-note-creator.ts` — `propertiesToOrgDrawer()` + `saveToEmacs()` + HTTP POST.
  - `extension/src/utils/__tests__/md-to-org.test.ts`, `org-note-creator.test.ts` — Vitest.
- **Modified:** `extension/src/core/popup.ts` (swap call), `extension/src/utils/cli-utils.ts` (swap CLI save), `extension/src/managers/general-settings.ts` + settings types/HTML (vault→Emacs transport), `extension/src/manifest.*.json` (rebrand), `emacs/org-clipper.el` (file pre-rendered Org).
- **Deleted after swap:** `extension/src/utils/obsidian-note-creator.ts`, vault UI, `obsidian://` handling, old `extension/src/*.js` (background.js, content-extract.js, dom-prep.js, reader.js, transport*.js, md-to-org.js, fetch-images.js, popup.js, options.js, reader-doc.js).

---

## Phase 1 — Stand up the fork, green and rebranded

### Task 1: Import the fork into the repo

**Files:**
- Delete: `extension/` (entire current vanilla-JS extension)
- Create: `extension/` from `../obsidian-clipper` (excluding its `.git`, `node_modules`, `dist`)

- [ ] **Step 1: Snapshot the upstream commit for provenance**

Run: `git -C ../obsidian-clipper rev-parse HEAD`
Record the hash; it goes in the README in Task 4.

- [ ] **Step 2: Replace extension/ with the fork**

```bash
cd /Users/liyanan/go/src/github.com/ed/org-clipper
git rm -r --quiet extension
rsync -a --exclude '.git' --exclude 'node_modules' --exclude 'dist' ../obsidian-clipper/ extension/
git add extension
```

- [ ] **Step 3: Install and build (verify the fork is intact)**

Run:
```bash
cd extension && npm install && npm run build:chrome
```
Expected: webpack completes, `extension/dist/` (or the configured output) is produced with `popup.html`, `background.js`, `content.js`, `manifest.json`.

- [ ] **Step 4: Run the upstream test suite (baseline green)**

Run: `cd extension && npm test`
Expected: Vitest passes (Obsidian's existing suite). Record the count.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ext): import Obsidian Web Clipper as the extension base (fork of <hash>)"
```

### Task 2: Preserve license + attribution

**Files:**
- Modify: `extension/LICENSE` (keep Obsidian's MIT), Create: `extension/NOTICE`

- [ ] **Step 1: Confirm MIT license carried over**

Run: `head -3 extension/LICENSE`
Expected: `MIT License` / `Copyright (c) 2024 Obsidian`.

- [ ] **Step 2: Add a NOTICE crediting the fork**

Create `extension/NOTICE`:
```
org-clipper's browser extension is a fork of Obsidian Web Clipper
(https://github.com/obsidianmd/obsidian-clipper), MIT © 2024 Obsidian,
forked at commit <hash>. Modifications © 2026 org-clipper contributors,
also MIT. The output layer was changed to send clips to Emacs/Org over HTTP.
```

- [ ] **Step 3: Commit**

```bash
git add extension/LICENSE extension/NOTICE
git commit -m "docs(ext): preserve Obsidian MIT license, add fork NOTICE"
```

### Task 3: Rebrand the manifests

**Files:**
- Modify: `extension/src/manifest.chrome.json`, `manifest.firefox.json`, `manifest.safari.json`

- [ ] **Step 1: Edit each manifest's identity fields**

In all three manifests set:
```jsonc
"name": "org-clipper",
"homepage_url": "https://github.com/ed/org-clipper",
"description": "Clip web pages to Emacs Org-mode (Defuddle extraction), sent over local HTTP.",
```
Leave `permissions`/`host_permissions` as-is — existing `<all_urls>` + `http://*/*` already permit the `http://127.0.0.1:17654` transport.

- [ ] **Step 2: Rebuild to verify manifests still valid**

Run: `cd extension && npm run build:chrome`
Expected: build succeeds; `dist/manifest.json` shows `"name": "org-clipper"`.

- [ ] **Step 3: Commit**

```bash
git add extension/src/manifest.*.json
git commit -m "feat(ext): rebrand manifests to org-clipper"
```

### Task 4: README provenance

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Browser extension" section**

Document: the extension is a fork of Obsidian Web Clipper at `<hash>`; build with `cd extension && npm run build:chrome`; load `extension/dist` unpacked; clips go to Emacs over HTTP (`M-x org-clipper-start`).

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document the forked extension and build"
```

---

## Phase 2 — Port md-to-org to TypeScript

### Task 5: Port `md-to-org.js` → `md-to-org.ts`

**Files:**
- Create: `extension/src/utils/md-to-org.ts` (port of `org-clipper`'s original `extension/src/md-to-org.js`, recoverable from git history at `main:extension/src/md-to-org.js`)
- Test: `extension/src/utils/__tests__/md-to-org.test.ts`

- [ ] **Step 1: Recover the original module**

Run: `git show main:extension/src/md-to-org.js > /tmp/md-to-org.js`
This is the tested converter (functions `mdToOrg`, `escapeSrcLine`, helpers; a `runTests()` block with 17 `assertEq` cases).

- [ ] **Step 2: Write the failing test (port the 17 self-tests to Vitest)**

Create `extension/src/utils/__tests__/md-to-org.test.ts`. Convert each `assertEq(mdToOrg(input), expected, label)` from the original `runTests()` into:
```ts
import { describe, it, expect } from 'vitest';
import { mdToOrg } from '../md-to-org';

describe('mdToOrg', () => {
  it('headings + paragraph', () => {
    expect(mdToOrg('# A\n\ntext')).toBe('* A\n\ntext\n');
  });
  // ... one it() per original assertEq case (17 total: lists, inline image,
  // block image #+CAPTION, code fences, blockquote, hr, footnotes, table cells,
  // emphasis precedence, src-block comma-escape, etc.). Copy each input/expected
  // verbatim from the original runTests().
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd extension && npx vitest run src/utils/__tests__/md-to-org.test.ts`
Expected: FAIL — `Cannot find module '../md-to-org'`.

- [ ] **Step 4: Create the TS module**

Port `/tmp/md-to-org.js` to `extension/src/utils/md-to-org.ts`: keep every function body identical; add `export function mdToOrg(md: string): string`; type helper params (`string`/`number`); delete the `isMain`/`runTests()` self-test block (now Vitest).

- [ ] **Step 5: Run to verify it passes**

Run: `cd extension && npx vitest run src/utils/__tests__/md-to-org.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 6: Commit**

```bash
git add extension/src/utils/md-to-org.ts extension/src/utils/__tests__/md-to-org.test.ts
git commit -m "feat(ext): port md-to-org converter to TypeScript + Vitest"
```

---

## Phase 3 — Org note creator + HTTP transport

### Task 6: `propertiesToOrgDrawer()`

**Files:**
- Create: `extension/src/utils/org-note-creator.ts`
- Test: `extension/src/utils/__tests__/org-note-creator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { propertiesToOrgDrawer } from '../org-note-creator';
import type { Property } from '../../types/types';

const p = (name: string, value: string, type = 'text'): Property =>
  ({ name, value, type } as Property);

describe('propertiesToOrgDrawer', () => {
  it('renders scalar properties into a drawer', () => {
    const out = propertiesToOrgDrawer([p('author', 'Jane'), p('source', 'https://x')]);
    expect(out).toBe(':PROPERTIES:\n:AUTHOR: Jane\n:SOURCE: https://x\n:END:');
  });
  it('joins multitext values with commas', () => {
    const out = propertiesToOrgDrawer([{ name: 'tags', value: 'a, b', type: 'multitext' } as Property]);
    expect(out).toBe(':PROPERTIES:\n:TAGS: a, b\n:END:');
  });
  it('skips empty values and returns empty string for no properties', () => {
    expect(propertiesToOrgDrawer([])).toBe('');
    expect(propertiesToOrgDrawer([p('empty', '')])).toBe('');
  });
  it('upcases and sanitises keys to valid drawer keys', () => {
    expect(propertiesToOrgDrawer([p('Created At', '2026-06-06')]))
      .toBe(':PROPERTIES:\n:CREATED_AT: 2026-06-06\n:END:');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && npx vitest run src/utils/__tests__/org-note-creator.test.ts`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Implement `propertiesToOrgDrawer`**

In `extension/src/utils/org-note-creator.ts`:
```ts
import type { Property } from '../types/types';

const orgKey = (name: string): string =>
  name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** Render compiled template properties as an Org :PROPERTIES: drawer. */
export function propertiesToOrgDrawer(properties: Property[]): string {
  const lines: string[] = [];
  for (const prop of properties) {
    const value = (prop.value ?? '').toString().trim();
    if (!value) continue;
    const key = orgKey(prop.name);
    if (!key) continue;
    lines.push(`:${key}: ${value.replace(/\n+/g, ' ')}`);
  }
  if (lines.length === 0) return '';
  return `:PROPERTIES:\n${lines.join('\n')}\n:END:`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd extension && npx vitest run src/utils/__tests__/org-note-creator.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/utils/org-note-creator.ts extension/src/utils/__tests__/org-note-creator.test.ts
git commit -m "feat(ext): properties -> Org property drawer"
```

### Task 7: `saveToEmacs()` HTTP transport

**Files:**
- Modify: `extension/src/utils/org-note-creator.ts`
- Modify: `extension/src/utils/__tests__/org-note-creator.test.ts`

- [ ] **Step 1: Write the failing test (mock fetch; mirror transport-http.js self-tests)**

Append to the test file:
```ts
import { saveToEmacs } from '../org-note-creator';
import { vi, beforeEach, afterEach } from 'vitest';

describe('saveToEmacs', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('POSTs an Org subtree to the capture endpoint with the token', async () => {
    const calls: any[] = [];
    globalThis.fetch = vi.fn(async (url: any, opts: any) => { calls.push({ url, opts }); return { ok: true, json: async () => ({}) } as any; });
    await saveToEmacs({
      properties: [{ name: 'author', value: 'Jane', type: 'text' } as any],
      body: 'Para with **bold**.',
      noteName: 'Title',
      behavior: 'create',
      url: 'https://x',
      tags: ['web'],
    }, { endpoint: '127.0.0.1:17654', token: 'secret', template: 'w' });

    expect(calls[0].url).toBe('http://127.0.0.1:17654/capture');
    expect(calls[0].opts.headers['X-Org-Clipper-Token']).toBe('secret');
    const sent = JSON.parse(calls[0].opts.body);
    expect(sent.title).toBe('Title');
    expect(sent.template).toBe('w');
    expect(sent.behavior).toBe('create');
    expect(sent.content).toContain('* Title');
    expect(sent.content).toContain(':AUTHOR: Jane');
    expect(sent.content).toContain('*bold*'); // md->org converted body
  });

  it('throws a friendly error when Emacs is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(saveToEmacs(
      { properties: [], body: 'x', noteName: 'T', behavior: 'create', url: 'u', tags: [] },
      { endpoint: '127.0.0.1:17654', token: '' },
    )).rejects.toThrow(/cannot reach Emacs/);
  });

  it('throws on non-200 with server detail', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'bad token' }) } as any));
    await expect(saveToEmacs(
      { properties: [], body: 'x', noteName: 'T', behavior: 'create', url: 'u', tags: [] },
      { endpoint: '127.0.0.1:17654', token: '' },
    )).rejects.toThrow(/HTTP 403: bad token/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && npx vitest run src/utils/__tests__/org-note-creator.test.ts`
Expected: FAIL — `saveToEmacs` not exported.

- [ ] **Step 3: Implement `saveToEmacs`**

Append to `extension/src/utils/org-note-creator.ts`:
```ts
import type { Template } from '../types/types';
import { mdToOrg } from './md-to-org';

export interface EmacsClip {
  properties: Property[];
  body: string;            // Markdown body from the template
  noteName: string;        // becomes the Org heading
  behavior: Template['behavior'];
  url: string;
  tags: string[];
}

export interface EmacsTransport {
  endpoint: string;        // host:port, default 127.0.0.1:17654
  token: string;
  template?: string;       // org-capture template key
}

/** Assemble the full Org subtree the extension renders for a clip. */
export function renderOrgSubtree(clip: EmacsClip): string {
  const heading = `* ${clip.noteName}`.trimEnd();
  const drawer = propertiesToOrgDrawer(clip.properties);
  const body = mdToOrg(clip.body || '').trimEnd();
  return [heading, drawer, body].filter(Boolean).join('\n');
}

export async function saveToEmacs(clip: EmacsClip, cfg: EmacsTransport): Promise<{ ok: true; bytes: number }> {
  const endpoint = (cfg.endpoint || '127.0.0.1:17654').replace(/^https?:\/\//, '');
  const url = `http://${endpoint}/capture`;
  const payload = {
    title: clip.noteName,
    content: renderOrgSubtree(clip),
    template: cfg.template || '',
    behavior: clip.behavior,
    url: clip.url,
    tags: clip.tags,
  };
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Org-Clipper-Token': cfg.token || '' },
      body: JSON.stringify(payload),
    });
  } catch (e: any) {
    throw new Error(`cannot reach Emacs at ${url} — is the daemon running and 'M-x org-clipper-start' done? (${e?.message || e})`);
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json())?.error || ''; } catch { /* ignore */ }
    throw new Error(`Emacs returned HTTP ${resp.status}${detail ? ': ' + detail : ''}`);
  }
  return { ok: true, bytes: new TextEncoder().encode(JSON.stringify(payload)).length };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd extension && npx vitest run src/utils/__tests__/org-note-creator.test.ts`
Expected: PASS (all org-note-creator tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/utils/org-note-creator.ts extension/src/utils/__tests__/org-note-creator.test.ts
git commit -m "feat(ext): saveToEmacs renders Org and POSTs over HTTP"
```

---

## Phase 4 — Swap the call sites

### Task 8: Swap the popup save

**Files:**
- Modify: `extension/src/core/popup.ts` (the `handleClipObsidian` body, around lines 1338-1351)

- [ ] **Step 1: Replace the save block**

Replace (current `:1338-1351`):
```ts
		const properties = getPropertiesFromDOM();
		const frontmatter = await generateFrontmatter(properties);
		const fileContent = frontmatter + noteContentField.value;
		const selectedVault = vaultDropdown.value || currentTemplate.vault || '';
		const isDailyNote = currentTemplate.behavior === 'append-daily' || currentTemplate.behavior === 'prepend-daily';
		const noteName = isDailyNote ? '' : noteNameField?.value || '';
		const path = isDailyNote ? '' : pathField?.value || '';
		await saveToObsidian(fileContent, noteName, path, selectedVault, currentTemplate.behavior);
		const tabInfo = await getCurrentTabInfo();
		await incrementStat('addToObsidian', selectedVault, path, tabInfo.url, tabInfo.title);
```
with:
```ts
		const properties = getPropertiesFromDOM();
		const noteName = noteNameField?.value || '';
		const tabInfo = await getCurrentTabInfo();
		await saveToEmacs(
			{
				properties,
				body: noteContentField.value,
				noteName,
				behavior: currentTemplate.behavior,
				url: tabInfo.url || '',
				tags: properties.find(p => p.name === 'tags')?.value.split(',').map(t => t.trim()).filter(Boolean) || [],
			},
			{ endpoint: generalSettings.emacsEndpoint, token: generalSettings.emacsToken, template: currentTemplate.emacsTemplate || generalSettings.emacsTemplate },
		);
		await incrementStat('addToObsidian', 'emacs', '', tabInfo.url, tabInfo.title);
```

- [ ] **Step 2: Fix imports**

In `popup.ts`, remove `import { saveToObsidian, generateFrontmatter } from '../utils/obsidian-note-creator';` and add `import { saveToEmacs } from '../utils/org-note-creator';`. Remove now-unused `vaultDropdown`/`pathField` reads if the type-checker flags them.

- [ ] **Step 3: Type-check**

Run: `cd extension && npx tsc --noEmit`
Expected: no errors (after Task 11 adds `emacsEndpoint`/`emacsToken`/`emacsTemplate` to settings types; until then expect the 3 known property errors — proceed, they close in Task 11).

- [ ] **Step 4: Commit**

```bash
git add extension/src/core/popup.ts
git commit -m "feat(ext): popup saves the clip to Emacs instead of Obsidian"
```

### Task 9: Swap the CLI save

**Files:**
- Modify: `extension/src/utils/cli-utils.ts` (the `obsidian://` builder ~`:80-110`) and its caller in `extension/src/cli.ts`

- [ ] **Step 1: Replace the CLI save function body**

Replace the `obsidian://` URL construction in `cli-utils.ts` with a Node `fetch` POST to `http://${endpoint}/capture` carrying `{ title, content, template, behavior, url, tags }` and the `X-Org-Clipper-Token` header — reuse `renderOrgSubtree`/`saveToEmacs` from `./org-note-creator` (Node 18+/the bundler provides `fetch`). Take `endpoint`/`token`/`template` from CLI args/env instead of `vault`.

- [ ] **Step 2: Build the CLI**

Run: `cd extension && npm run build:cli`
Expected: builds without referencing `obsidian://`.

- [ ] **Step 3: Commit**

```bash
git add extension/src/utils/cli-utils.ts extension/src/cli.ts
git commit -m "feat(cli): headless clip POSTs Org to Emacs over HTTP"
```

---

## Phase 5 — Settings swap (vault → Emacs transport)

### Task 10: Settings model

**Files:**
- Modify: `extension/src/utils/storage-utils.ts` (the `generalSettings` defaults + `Settings` type) and `extension/src/types/types.ts`

- [ ] **Step 1: Add Emacs transport fields to the settings type + defaults**

Add to the settings interface and the defaults object:
```ts
emacsEndpoint: string; // default '127.0.0.1:17654'
emacsToken: string;    // default ''
emacsTemplate: string; // default 'w'
emacsDefaultTags: string; // default ''
```
Default values: `emacsEndpoint: '127.0.0.1:17654'`, `emacsToken: ''`, `emacsTemplate: 'w'`, `emacsDefaultTags: ''`. Optionally add `emacsTemplate` to `Template` for per-template override.

- [ ] **Step 2: Type-check (popup errors from Task 8 should now clear)**

Run: `cd extension && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add extension/src/utils/storage-utils.ts extension/src/types/types.ts
git commit -m "feat(ext): add Emacs transport settings"
```

### Task 11: Settings UI

**Files:**
- Modify: `extension/src/managers/general-settings.ts`, `extension/src/settings.html`, locale `extension/src/_locales/en/messages.json`

- [ ] **Step 1: Replace the vault settings section with an Emacs transport section**

In `general-settings.ts` and `settings.html`, remove the vault list UI and add inputs bound to `emacsEndpoint`, `emacsToken`, `emacsTemplate`, `emacsDefaultTags` (read on load, persisted on change via the existing `saveSettings` path). Add the corresponding `__MSG_*` strings to `messages.json`.

- [ ] **Step 2: Remove the vault picker from the popup**

In `popup.ts`/`popup.html` remove `#vault-select` and the `addVaultsToDropdown`-style code (or hide it). Keep `#note-name-field` and `#note-content-field`.

- [ ] **Step 3: Build + manual check**

Run: `cd extension && npm run build:chrome`
Load `extension/dist` unpacked; open Settings; confirm the Emacs fields render, persist across reload, and the popup no longer shows a vault picker.

- [ ] **Step 4: Commit**

```bash
git add extension/src
git commit -m "feat(ext): replace vault settings/picker with Emacs transport config"
```

---

## Phase 6 — Emacs receiver

### Task 12: File the pre-rendered Org subtree over HTTP

**Files:**
- Modify: `emacs/org-clipper.el` (the HTTP `/capture` handler + a new insert path)
- Test: `emacs/test/org-clipper-test.el`

- [ ] **Step 1: Write a failing ERT test for filing pre-rendered content**

In `emacs/test/org-clipper-test.el` add a test that calls the new `org-clipper--insert-rendered` (to be created) with a payload plist `(:title "T" :content "* T\n:PROPERTIES:\n:AUTHOR: Jane\n:END:\nbody" :behavior "create" :url "u" :tags ["web"])` against a temp target file, then asserts the file contains the heading re-leveled under `org-clipper-target-headline`, the drawer, and `body`.

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: FAIL — `org-clipper--insert-rendered` undefined.

- [ ] **Step 2: Implement `org-clipper--insert-rendered`**

Add a function that takes the payload plist, re-levels `:content` under the target headline using the existing `org-clipper--relevel-body`, and inserts according to `:behavior` (`create`/`append`/`prepend`/`overwrite`) at the target — reusing `org-clipper--capture-target-file`, `org-clipper--goto-target-headline`, and the existing save path. Route the HTTP `/capture` handler to this function when the payload carries `:content` (pre-rendered) instead of discrete fields.

- [ ] **Step 3: Run the test**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add emacs/org-clipper.el emacs/test/org-clipper-test.el
git commit -m "feat(emacs): file pre-rendered Org subtree from the HTTP capture"
```

### Task 13: End-to-end manual verification

- [ ] **Step 1: Start the receiver**

In Emacs: `M-x org-clipper-start` (confirm it listens on `127.0.0.1:17654`; set `org-clipper-token` to match the extension setting).

- [ ] **Step 2: Clip a normal article**

Load `extension/dist` unpacked, open an article, click the extension, Add to Emacs. Confirm an Org entry appears under the target headline with a `:PROPERTIES:` drawer and Org body.

- [ ] **Step 3: Clip a YouTube video with captions**

Open a captioned YouTube watch page, clip it. Confirm the transcript lands as Org (Defuddle's async extractor runs via Obsidian's `parseAsync` path — no Trusted-Types hang, since this is a declared content script).

- [ ] **Step 4: Error path**

Stop the receiver, clip again, confirm the popup shows the friendly "cannot reach Emacs" error.

---

## Phase 7 — Prune dead Obsidian-isms

### Task 14: Delete the replaced output layer + old extension code

**Files:**
- Delete: `extension/src/utils/obsidian-note-creator.ts`
- Verify deleted in Task 1: old vanilla-JS `extension/src/*.js` (background.js, content-extract.js, dom-prep.js, reader.js, transport*.js, md-to-org.js, fetch-images.js, popup.js, options.js, reader-doc.js, content-extract test fixtures that referenced them)

- [ ] **Step 1: Remove `obsidian-note-creator.ts` and any remaining imports/`obsidian://` references**

Run: `cd extension && grep -rnE "obsidian://|saveToObsidian|obsidian-note-creator" src/ ; rm src/utils/obsidian-note-creator.ts`
Expected after edits: grep returns nothing.

- [ ] **Step 2: Full build + test**

Run: `cd extension && npm run build && npm test && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore(ext): remove Obsidian save layer and dead references"
```

### Task 15: Final full-suite gate

- [ ] **Step 1: Run everything**

Run:
```bash
cd extension && npm test && npm run build:chrome && npm run build:firefox && npm run build:safari
emacs -Q --batch -L ../emacs -l ../emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit
```
Expected: Vitest green, all three browser builds succeed, ERT green.

- [ ] **Step 2: Commit any final fixes; open a PR from `fork-obsidian-clipper`.**

---

## Self-review notes

- **Spec coverage:** fork import (T1), license (T2), rebrand (T3), md→org port (T5), frontmatter→drawer (T6), saveToEmacs/HTTP (T7), popup swap (T8), CLI swap (T9), settings swap (T10-11), Emacs receiver (T12-13), prune org-protocol/`obsidian://`/vault (T8-11,T14) — all spec sections mapped.
- **HTTP-only:** no org-protocol anywhere in the extension; only `http://…/capture`.
- **Type consistency:** `EmacsClip`/`EmacsTransport`/`saveToEmacs`/`renderOrgSubtree`/`propertiesToOrgDrawer` names are used identically across Tasks 6-9; `emacsEndpoint`/`emacsToken`/`emacsTemplate` defined in Task 10 before use closes the Task 8 type errors.
- **Known ordering caveat:** Task 8 intentionally precedes Task 10, so `tsc` has 3 expected errors until Task 10 — called out in Task 8 Step 3.
