# One file per clip + `:SOURCE:` dedup via vulpea

**Date:** 2026-06-26
**Status:** Design (pending review)

## Problem

Today every clip is appended into one shared Org file (`~/org/inbox.org`, or a
monthly file) as a `** <title>` child under a single `* Web clips` heading. Two
consequences:

1. The file grows without bound; re-clipping the same URL silently creates a
   duplicate.
2. The structure (`* Web clips` grouping + heading-level nodes) does not match
   the user's standard `~/org` note format (file-level vulpea node with
   `#+title` + a top property drawer).

We want, going forward:

- **One file per clipped page**, bucketed by capture date:
  `~/org/inbox/2026-06/2026-06-26/<slug>.org`.
- **No `* Web clips` grouping level** — the file *is* the node.
- **Duplicate detection**: before writing, look the page's URL up in vulpea by
  `:SOURCE:`. If already clipped, write nothing and report the existing file's
  path (relative to `~/org`) back to the browser popup.

And, as a one-time step:

- **Migrate all existing clips** (`~/org/inbox/**` daily files and
  `~/org/llvim/Clippings/*.org`) into this same format.

## Context (grounded, not assumed)

- The active note system is **vulpea 2.x**, not org-roam (org-roam is inert).
  Vulpea has its own DB and **indexes any file under `~/org` that has an `:ID:`,
  on save** (autosync). New clip files land under `~/org/inbox/...` ⊂ `~/org`,
  so they are auto-indexed. *(Verified: Doom config + `~/org` `org-mode`
  SKILL.md.)*
- **Dedup by `:SOURCE:` is feasible.** A vulpea query over all notes for a
  `SOURCE` property equal to the URL works today: **289 existing clips** already
  carry `:SOURCE:` and are returned by `vulpea-note-properties`. *(Verified by
  POC.)*
- **Cost:** a full `vulpea-db-query` lambda-scan over **4268 notes** takes
  **~438 ms**. Acceptable per clip; we will try a faster direct-emacsql query
  with the scan as a guaranteed-correct fallback. *(Measured.)*
- **Transport in real use is HTTP** (`saveToEmacs` POSTs JSON to
  `127.0.0.1:17654/capture`); the response already carries `{ok,error}` — the
  natural channel for "already clipped" feedback. The org-protocol path is
  fire-and-forget (Emacs `message` only).
- **Attachments are location-independent.** `org-attach-id-dir` is a global,
  UUID-keyed dir (`~/org/.attach/`); attachments resolve by `:ID:`, never by
  file location. Moving/relocating a clip cannot break its attachments **as long
  as `:ID:` is preserved**. *(Verified: daemon read.)*

## Target format (shared by Phase A and Phase B)

A single **file-level vulpea node**, matching the user's `~/org` node
convention:

```org
:PROPERTIES:
:ID:          <uuid>
:SOURCE:      <url>                 ; always present (may be empty)
:AUTHOR:      <author>             ; always present (empty string if none)
:PUBLISHED:   <YYYY-MM-DD>          ; omitted if empty
:CREATED:     <YYYY-MM-DD day>      ; always present
:DESCRIPTION: <one line>            ; omitted if empty
:READING_TIME: ...                  ; extra template props, omitted if empty
:END:
#+title: <Title>
#+filetags: :clippings:<extra tags>:

<body — Org headings re-leveled so the shallowest becomes level 1>
```

Property rules:

| Property            | Presence                                            |
| ------------------- | --------------------------------------------------- |
| `ID`                | always (generated for new clips; **preserved** in migration) |
| `SOURCE`            | always (URL; empty string if unknown)               |
| `AUTHOR`            | **always** — empty string when absent *(new requirement)* |
| `CREATED`           | always                                              |
| `PUBLISHED`         | only when non-empty                                 |
| `DESCRIPTION`       | only when non-empty                                 |
| extra template keys | only when non-empty                                 |

> Scope note: only **AUTHOR** changes from "omitted if empty" to
> "always present, empty when absent." PUBLISHED/DESCRIPTION/extras keep the
> omit-if-empty behavior. (Adjust if you want *all* standard keys always-present.)

### Filename slug

From the title:

1. Lowercase (ASCII; CJK unaffected).
2. Replace each run of non-`[[:alnum:]]` (Emacs `[:alnum:]` is unicode-aware, so
   **Chinese/letters survive**; spaces/punctuation become `-`).
3. Trim leading/trailing `-`, collapse repeats.
4. Truncate to ≤ `org-clipper-filename-max-slug` chars (default 80), on a char
   boundary.
5. Empty result (all-punctuation title) → URL host → `untitled`.
6. **Collision**: if `<slug>.org` exists in the target dir, append `-2`, `-3`, …

### Path

`<org-clipper-clip-root>/<YYYY-MM>/<YYYY-MM-DD>/<slug>.org`, dirs auto-created.
The date is the **capture date** (`:CREATED:`), not the article's published
date — matching the existing `inbox/2026-06/...` layout. New clips use
`current-time`; migrated clips use each clip's `:CREATED:`.

## Phase A — new clip flow

### A1. Elisp: writer + path

- New defcustoms: `org-clipper-clip-root` (default `~/org/inbox`, = current
  `org-clipper-monthly-dir`), `org-clipper-filename-max-slug` (80).
- `org-clipper--slug (title url)` → slug per rules above.
- `org-clipper--clip-file-path (title url time)` → bucketed absolute path with
  collision suffixing; makes the directory.
- `org-clipper--clip-file-content (id title url tags clip)` → the file-level
  node string above. Reuses `org-clipper--relevel-body` with **base 1** and the
  existing stamp/sanitize helpers. Tags → `#+filetags:`.
- Retire from the write path: `org-clipper-target-headline` ("Web clips"),
  `org-clipper--goto-target-headline`, `org-clipper-prepend`. Old defcustoms
  remain *defined* (don't break user config) but unused, with a deprecation note
  in their docstrings. `org-clipper-visit-target` is repointed to open the clip
  root (`org-clipper-clip-root`) in dired; `org-clipper-refile` keeps working on
  the current file's single node (low priority — the per-file model makes
  cross-file refile near-moot).

### A2. Elisp: dedup

- `org-clipper--find-by-source (url)` → existing note's **absolute path** or nil.
  - Fast path: direct emacsql query against vulpea's DB for a `SOURCE`-property
    match (schema validated during implementation).
  - Fallback: `seq-find` over `vulpea-db-query` (the measured 438 ms scan).
  - Also consult an in-session `org-clipper--clipped-this-session` hash (URL→
    relpath) to cover the autosync-lag race between two rapid clips.
- Empty URL ⇒ never a duplicate (skip the query).

### A3. Elisp: insert flow

`org-clipper--insert-clip` becomes:

1. Sanitize clip (unchanged).
2. If URL non-empty and `org-clipper--find-by-source` hits → return
   `(:duplicate . <relpath>)` where `relpath = (file-relative-name hit
   org-directory)` (e.g. `inbox/2026-06/2026-06-01.org`). **Write nothing.**
3. Else: compute path, write the file (`with-temp-file`, no buffer visiting
   needed for a fresh file — but images/attach need a visited buffer; see A5),
   record URL→relpath in the session hash, return the path string.

### A4. Elisp + extension: feedback to browser popup

- HTTP handler contract extends to `(CODE MESSAGE &optional EXTRA-PLIST)`.
  Duplicate ⇒ `(200 "ok" (:duplicate t :path "inbox/..."))`.
- `org-clipper--http-respond` merges EXTRA into the JSON →
  `{"ok":true,"duplicate":true,"path":"inbox/2026-06/01/..."}` (HTTP **200** —
  not an error).
- `saveToEmacs` return type → `{ok:true;bytes} | {ok:true;duplicate:true;path}`;
  parse `resp.json()`.
- `popup.ts handleClipObsidian`: on `duplicate`, show a localized neutral notice
  `getMessage('emacsAlreadyClipped', [path])` ("Already clipped → $1") and **do
  not auto-close**; otherwise behave as today. Add the string to `_locales/en`
  (others fall back).
- org-protocol path (no browser channel): on duplicate, Emacs `message` only.

### A5. Images / attachments (file-level node)

Images still attach to the node's `org-attach` dir, now keyed by the **file-level
`:ID:`**:

- After writing the file, visit it (lean, hooks suppressed), put point in the
  file-level entry (before the first heading), `org-id` already in the drawer;
  `org-attach-dir-get-create` resolves under `~/org/.attach/<id>`.
- `org-clipper--attach-images` unchanged in spirit; `--rewrite-image-links`
  rewrites **buffer-wide** (drop the `org-narrow-to-subtree`, since the file is
  one node).
- **POC-2 (pre-impl):** confirm file-level `org-attach` dir + link rewrite on a
  file node. If file-level attach is awkward, fall back to a single top heading
  `* <Title>` node (see risk below).

### A6. Tests (elisp + TS)

- Slug: ASCII, Chinese, mixed, empty→fallback, collision suffix.
- Path bucketing from a fixed time.
- File-node content: asserts `#+title:`, `:SOURCE:`, **`:AUTHOR:` present even
  when empty**, `#+filetags: :clippings:`, body at `*` level, and **no
  `* Web clips`**. Replace the existing `^\* Web clips$` assertion.
- Dedup: stub `org-clipper--find-by-source` → `--insert-clip` returns
  `(:duplicate . relpath)` and writes nothing.
- TS: `saveToEmacs` surfaces `{duplicate,path}` from a mocked response.

## Phase B — one-time migration

Runs **after** Phase A is built and verified, because it **reuses the Phase-A
writer** so migrated files are shape-identical to fresh clips.

### B1. Sources & selection

- **inbox**: walk `org-clipper-clip-root` (`~/org/inbox/**/*.org`) plus
  `~/org/inbox.org` if present. In each, process only `**` clip headings under a
  `* Web clips` heading. → naturally **excludes `marginalia.org`** (datetree
  quote collections, no `* Web clips`, no `:SOURCE:`).
- **llvim**: each `~/org/llvim/Clippings/*.org`; the node is the `* <title>`
  heading (also read `#+TITLE/#+SOURCE/#+CREATED/#+DESCRIPTION/#+TAGS` keywords
  as fallbacks).
- Extract each into a clip plist: `:id` (**preserved**), `:url` (=SOURCE),
  `:title`, `:author`, `:created`, `:published`, `:description`, `:tags`,
  `:body` (subtree content, re-leveled to base 1).

### B2. Recover missing `:SOURCE:` via verified web search

For clips with no `:SOURCE:` (6 known in llvim; possibly a few inbox headings):

1. Web-search the title.
2. **Verify** the candidate page against the clip body (match a distinctive
   sentence/phrase), not just a title match.
3. Confident match → set `:SOURCE:` to the canonical URL. Unconfirmed → migrate
   with **empty `:SOURCE:`** and flag in the report.
4. Surface the proposed URL + evidence for the user to confirm before applying
   (small set, ~6). **No URL is written silently.**

### B3. Dedup across sources

Key by `:SOURCE:`. Policy: **prefer inbox** — when a URL exists in both inbox and
llvim, keep the inbox copy and drop the llvim one. Within the same source, keep
the earliest `:CREATED:`. All drops are logged in the report. (Empty-SOURCE clips
are never deduped.)

### B4. Write & remove

- For each kept clip: target path bucketed by its `:CREATED:` (fallbacks:
  `#+CREATED:` → `:PUBLISHED:` → file mtime), written via the Phase-A writer
  with the **existing `:ID:`** and **no image re-fetch** (links preserved as-is).
- **Remove sources** ("move" semantics):
  - llvim: delete the original file after its target is written.
  - inbox: cut the migrated `**` heading; when a daily file's `* Web clips`
    becomes empty, delete the file.
- Already-migrated per-page files (file nodes not under `* Web clips`) are
  skipped → migration is **idempotent**.

### B5. Safety & daemon hygiene

- **Dry-run first** (`org-clipper-migrate` with a dry-run flag default): do B1–B3
  and compute the B4 plan, **write/delete nothing**, emit the full report
  (counts: to-create, dupes-dropped + winner, no-URL recovered/left, sources to
  delete, errors).
- `~/org` is git-tracked → the real run is reviewed via `git status`/`git diff`
  and revertable.
- During the batch, bind `after-save-hook`/`org-mode-hook`/`find-file-hook` to
  nil (no per-file autosync, no LSP/grammar). Write new files with
  `with-temp-file` where attachments aren't involved. Run **one** quiet
  `vulpea-db-sync` at the very end (config already sets
  `vulpea-db-sync-verbose nil`; avoid mid-redisplay message spam per the SKILL
  warning).

### B6. Report

A `*org-clipper-migrate*` buffer: created N, dupes dropped M (URL → winner),
no-URL recovered K / left L, sources deleted, and any errors.

## Risks & validations

1. **vulpea indexes file-level custom props (`:SOURCE:`)** — proven for
   *heading* nodes (289 clips), not yet for *file-level* nodes.
   **POC-1 (pre-impl):** write a temp file-level node with `:SOURCE:` under
   `~/org`, sync, query, clean up. If it fails, fall back to a single top heading
   `* <Title>` per file (still one-file-per-page, still no `* Web clips`,
   dedup-proven). Everything else in the design is unchanged.
2. **File-level `org-attach`** — POC-2 (A5).
3. **Migration scale** — ~30 inbox files (many headings) + 157 llvim files,
   write ~hundreds of files + delete sources. Mitigated by deferred autosync +
   single final sync + dry-run + git.

## Non-goals

- No migration of `marginalia.org` or non-clip notes.
- No URL normalization for dedup (exact `:SOURCE:` match).
- No image localization during migration (remote/`data:` links preserved as-is;
  the existing `org-clipper-localize-remote-images` is the follow-up — the 2
  `data:` llvim files are flagged for it).
- No change to Defuddle extraction.

## Implementation order

1. POC-1 (file-level vulpea `:SOURCE:`) + POC-2 (file-level org-attach).
2. Phase A (writer, path, dedup, HTTP feedback, extension popup, tests).
3. Verify Phase A with a real clip end-to-end.
4. Phase B reusing the Phase-A writer; **dry-run**; user reviews the plan.
5. Phase B real run; `git diff` review.
