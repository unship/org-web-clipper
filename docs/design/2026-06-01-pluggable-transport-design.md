# org-clipper — Pluggable transport (org-protocol + HTTP) & capture-core redesign

- **Status:** Draft for review
- **Date:** 2026-06-01
- **Scope:** `extension/` and `emacs/org-clipper.el` (and the maintainer's Doom `+clipper` mirror)

## 1. Goals

- Support arbitrarily long documents with **no silent truncation and no encoding errors**.
- Captures are **fast** and **never block the Emacs daemon**.
- Keep **org-protocol as the default** (zero extra process — the project's original selling point); add **HTTP as an opt-in transport** for robust/long captures.
- **Open-source friendly:** both transports first-class and documented with their trade-offs; the default is the least-surprising one.
- **Preserve all Obsidian-Clipper metadata** (title, source, author, published, created, description, tags) plus a generated `:ID:`, in an Org PROPERTIES drawer — parity with the YAML frontmatter Obsidian Clipper produces.
- Remove the `fill-on-finalize` feature.

### Non-goals

- Cross-machine capture (HTTP could enable it later; out of scope).
- Monthly-file rotation (a future tunable).
- TLS (the model is `127.0.0.1` + shared token).

## 2. Background / motivation (measured)

- org-protocol carries the **whole body inside one URL**. macOS LaunchServices / Chrome truncate long URLs → **silent data loss** (verified: not corrupted, but the tail is dropped). Chinese inflates ~9× in the URL (`字` → 3 UTF-8 bytes → `%XX%XX%XX`).
- Per-clip cost measured on a 540 KB monthly file:
  - full `org-mode-hook` init ≈ **3.637 s** (the target buffer was not kept open, so this was paid on every clip);
  - `org-link-decode` up to **3.5 s** at 738 KB;
  - `fill-on-finalize` is superlinear: **4.2 s @ 246 KB, 8.7 s @ 492 KB, 13.3 s @ 738 KB** — and it is pure decoration (paragraph rewrapping).
- The Emacs daemon is single-threaded; any synchronous network wait or unanswerable prompt freezes **all** frames. (Several daemon freezes occurred during diagnosis.)
- The encoding environment is clean UTF-8 and `org-link-decode` round-trips Chinese+emoji losslessly (and is robust to mid-`%XX` truncation). The reported "encoding error on long/Chinese pages" is **not** the decode path; it is most consistent with the **on-save prose formatter** (`+prose--org-formatter-h` → apheleia → CJK `autocorrect`). Both that and the per-clip init are removed from the clip path by the lean persistent buffer + fill removal.

## 3. Architecture: pluggable transport, one capture core

```
                              ┌──────────────────────────────┐
extension `transport` setting │ org-protocol → transport-orgproto.js │──URL──┐
 (org-protocol | http) ──────►│ http         → transport-http.js     │──POST─┤
                              └──────────────────────────────┘              │
                                                                            ▼
emacs `org-clipper-transport`        ┌────────────── shared capture core ──────────────┐
 (org-protocol | http) ──┬─ orgp ───►│ org-clipper--insert-clip                          │
                         │  sub-proto handler → org-link-decode →                        │
                         └─ http ───►│   (template url title body tags)                  │
                            async httpd → JSON →  ensure lean persistent buffer →         │
                                       │  prepend entry under headline → save → ACK      │
                                       └───────────────────────────────────────────────────┘
```

- **Transport front-ends** only turn "bytes arriving" into a single call to the shared core.
- **Shared core** is written once; both transports converge on it.
- Selected by `org-clipper-transport` (Emacs) and `transport` (extension). **The two ends must match**; a mismatch surfaces a clear error, never a silent failure.
- No runtime cost for the unused transport (it is never started).

## 4. Capture payload (transport-agnostic)

Both transports carry the same logical payload:

```
{ template:    "w",          // selects an org-clipper capture profile (target + headline + format)
  url:         "https://…",  // → :SOURCE:
  title:       "Page title",
  body:        "…already-Org text (md→org done in the browser)…",
  tags:        ["clippings","ai"],
  author:      "David Álvarez Rosa",   // Defuddle metadata (content-extract.js already has these)
  published:   "",                     // original publish date (may be empty)
  description: "A single-producer single-consumer queue …",
  created:     "2026-03-28" }          // capture date (browser-side capturedAt)
```

`md-to-org` conversion and heading-level shaping stay **in the browser** (keeps that CPU off the daemon). `template` selects an org-clipper profile (default `w`); it is **not** an `org-capture-templates` key anymore (see §7). The metadata fields (`author`/`published`/`description`/`created`) come from Defuddle (`content-extract.js`) and are mapped to the entry's PROPERTIES drawer — the org equivalent of Obsidian Clipper's YAML frontmatter (see §7). They are short, so they do not affect transport limits; only `body` does.

## 5. Transport: org-protocol (default)

- **Extension** builds `org-protocol://org-clipper?template=…&url=…&title=…&body=…&tags=a,b&author=…&published=…&description=…&created=…` (a dedicated `org-clipper` sub-protocol, percent-encoded with `encodeURIComponent`) and dispatches it via the existing hidden-iframe (popup) / background-tab (keyboard command) mechanism. (The metadata params are short; only `body` pushes the URL toward the length limit.)
- **Emacs** registers an `org-clipper` entry in `org-protocol-protocol-alist`; its handler `org-link-decode`s each parameter and calls `org-clipper--insert-clip`.
- **Inherent limit:** URL length → super-long documents are truncated upstream by the OS handler. This is documented as the trade-off for the zero-port default.

## 6. Transport: HTTP (opt-in)

Wire protocol (we control both ends, so the format is fixed and minimal):

```
POST /capture HTTP/1.1
Host: 127.0.0.1:<port>
Content-Type: application/json; charset=utf-8
X-Org-Clipper-Token: <token>
Origin: chrome-extension://<id>
Connection: close
Content-Length: <n>

{"template":"w","url":"…","title":"…","body":"…","tags":["clippings","ai"],
 "author":"…","published":"","description":"…","created":"2026-03-28"}

← 200 {"ok":true}                 (only after the clip is saved — see §7)
← 403 {"ok":false,"error":"bad token"}
← 400 {"ok":false,"error":"…"}    ← 413 (body over cap)   ← 500 {"ok":false,"error":"…"}
```

- **Emacs server:** `make-network-process :server t :family 'ipv4 :host "127.0.0.1" :service <port> :filter org-clipper--http-filter`. Asynchronous — **the daemon never blocks on the socket**.
- **Parser:** hand-rolled minimal HTTP/1.1 in the filter — accumulate bytes per connection (a process property), read headers to `\r\n\r\n`, honor `Content-Length`, require `Connection: close`. ~50 lines, zero dependency, single known client.
- Validate token + Origin + method/path; enforce a body-size cap.
- Parse JSON, call `org-clipper--insert-clip`, then write the HTTP response.

## 7. Shared capture core: `org-clipper--insert-clip`

`(org-clipper--insert-clip template url title body tags)`:

1. Resolve the profile for `template` (target file, headline, entry format). Default profile `w` → `org-clipper--current-target-file` (monthly file) under "Web clips".
2. **Ensure the lean persistent target buffer** (reuse `org-clipper--capture-target-file`: opened with `org-mode-hook` bound `nil`, kept alive). org-mode init is paid once, not per clip; ltex/LSP/cdlatex/prose-formatter never attach to clip files.
3. **Prepend** the entry as the first child of the headline (newest on top), writing all Obsidian-Clipper metadata into the PROPERTIES drawer (the org equivalent of YAML frontmatter):
   ```org
   * <title>  :clippings:tag1:tag2:
   :PROPERTIES:
   :ID:          <generated org-id>
   :SOURCE:      <url>
   :AUTHOR:      <author>
   :PUBLISHED:   <published date, if any>
   :CREATED:     [<capture date>]
   :DESCRIPTION: <description>
   :END:

   <body>
   ```
   `:ID:` (via `org-id`) and `:CREATED:` are always emitted; `:AUTHOR:`/`:PUBLISHED:`/`:DESCRIPTION:` only when non-empty. The link property is **`:SOURCE:`** (aligned with Obsidian Clipper, not the old `:URL:`). **`:AUTHOR:` is stored as plain text** (e.g. `David Álvarez Rosa`): property values are best kept as simple queryable scalars (greppable, sortable, usable in `org-ql`/column view/`org-roam` property queries), and this avoids capture-time org-roam node lookups (perf) and Obsidian-style `[[author]]` links. A separate on-demand command could later convert `:AUTHOR:` text into a roam link. Tags on the headline always include `org-clipper-default-tags` (default `("clippings")`) merged with the user's tags.
4. `save-buffer`. For HTTP, the 200 response is sent **after** the save succeeds (**ACK-after-save**: accurate success/failure, zero silent loss). org-protocol has no response channel; failures are surfaced via `message`/notification.
5. **No `org-capture`** machinery (no capture buffer, no `org-capture-mode-hook`, no `:before-finalize`) — but the core itself generates the `:ID:` (`org-id`) and writes the full metadata drawer, so **nothing the old capture hooks provided is lost** (`:ID:`, `:CREATED:`, author, etc. are all preserved). Minimal main-thread time.

## 8. Removed: fill-body

Delete `org-clipper-fill-body`, `org-clipper--fill-body-on-finalize`, and the `:before-finalize` wiring. Both transports benefit (the superlinear cost is gone).

## 9. Configuration

### Defaults (out of the box)

| Side | Setting | Default |
|---|---|---|
| Emacs | `org-clipper-transport` | `org-protocol` |
| Extension | `transport` | `org-protocol` |

### How to switch to HTTP (the maintainer's local setup)

**Emacs:**
```elisp
(setq org-clipper-transport 'http
      org-clipper-http-port  17654)        ; any free local port
;; token is auto-generated on first start and written to
;;   ~/.config/org-clipper/token   (chmod 600)
(org-clipper-start)                        ; start the 127.0.0.1 listener
;; M-x org-clipper-show-token   prints it for pasting into the extension
```
Start automatically on a daemon: add `(org-clipper-start)` after the `+clipper` setup (guarded by `(eq org-clipper-transport 'http)`).

**Extension → Options:**
- `Transport` = **HTTP**
- `Endpoint` = `127.0.0.1:17654`
- `Token` = *(paste the contents of `~/.config/org-clipper/token`)*

Both ends must be `http`. If the extension is `http` but Emacs is `org-protocol` (listener down), the POST gets connection-refused and the popup says so explicitly.

### Settings

| Setting | Extension (Options) | Emacs |
|---|---|---|
| transport | `transport` (org-protocol \| http) | `org-clipper-transport` |
| http endpoint | `endpoint` (host:port) | `org-clipper-http-port` (+ host fixed 127.0.0.1) |
| http token | `token` | `org-clipper-http-token` / `~/.config/org-clipper/token` |
| template/profile | `captureTemplate` | profile registry (default `w`) |
| default tags | `defaultTags` (user) | `org-clipper-default-tags` (default `("clippings")`, always merged) |
| heading min level | `headingMin` | — (applied in browser) |

## 10. Error handling

| Condition | Behavior |
|---|---|
| HTTP: Emacs/listener down (connection refused) | extension catches, popup: "Emacs endpoint unreachable — daemon running? `M-x org-clipper-start`?"; **no auto-retry** (avoid double-capture); command path shows ERR badge |
| HTTP: bad/missing token | 403 → popup "bad token, check Options" |
| HTTP: body over cap | 413 |
| HTTP: malformed JSON / missing field | 400 |
| capture failure (target unwritable, etc.) | HTTP: 500 with message (response is sent only after save, so this is accurate); org-protocol: `message` + error notification |
| transport mismatch between ends | clear error, never silent |

## 11. Performance budget & invariants

Hard invariants:
- **The daemon never blocks on I/O** (async `make-network-process` filter; no synchronous `accept-process-output`/`url-retrieve` on the capture path).
- HTTP path does **no `org-link-decode`** (0 cost; body arrives as UTF-8), **no fill**, **no per-clip org-mode init** (lean buffer reused).

Targets (to verify after implementation):
- normal clip (10–50 KB): Emacs-side **< ~100 ms**;
- super-long (~500 KB body, HTTP): a few hundred ms, dominated by `save-buffer` (O(file size));
- the only residual O(n) is "monthly file grows → save slower" + `after-save-hook` (vulpea/org-roam db autosync, since the inbox is inside `org-roam-directory`).

Mitigations:
- monthly-file rotation / size cap: future tunable, out of scope.
- (No vulpea/org-roam autosync exclusion — autosync stays on for clip files, per maintainer preference.)

## 12. Security model (HTTP)

- Bind **`127.0.0.1`** only (no LAN exposure).
- **Shared token** in `X-Org-Clipper-Token` (primary defense): a custom header forces a CORS **preflight** that websites cannot satisfy (we return no permissive CORS headers), while the extension's service-worker fetch (with `host_permissions`) is exempt → websites are rejected by construction; a local malicious process can forge headers but does not know the token.
- Verify `Origin` is `chrome-extension://<id>` or absent; reject website origins. Accept only `POST /capture`.
- Body-size cap (default ~20 MB) to bound memory; over-cap → 413 and close.
- The payload is **data, never code**: `template` is validated against a profile allowlist; `url/title/body/tags` are inserted as literal text; nothing from the request is `eval`'d.
- No TLS: `127.0.0.1` is a "potentially trustworthy" origin, so an https page's service worker may fetch it without a mixed-content block.

## 13. Testing plan

- **Extension (Node self-tests, existing style):** `transport-http.sendCapture` with mocked `fetch` (200 / 403 / connection-refused); `transport-orgproto` URL building (round-trip decode, tags, escaping); `buildCapturePayloadForTab` payload shape.
- **Emacs (ERT / batch):**
  - `org-clipper--http-filter` fed canned request strings: valid, bad token, oversized, **split across packets**, bad JSON → assert response + parsed fields. Pure, no real socket.
  - `org-clipper--insert-clip` called directly into a temp file → assert entry shape, **all metadata properties present** (`:ID:` generated, `:SOURCE:`/`:AUTHOR:`/`:PUBLISHED:`/`:CREATED:`/`:DESCRIPTION:`), empty optional fields omitted, **Chinese/emoji intact**, prepend order, idempotent; runs with `org-mode-hook` nil (no daemon-hook side effects).
  - org-protocol handler: feed an encoded param string → assert it decodes and reaches `insert-clip`.
  - Integration: start the listener on a test port, POST via `curl`, assert the temp file; tear down the listener.
- **Performance:** `insert-clip` + save timed at 50 KB / 500 KB.

## 14. Component / file change list

**Extension**
- `manifest.json`: add `host_permissions: ["http://127.0.0.1/*"]`.
- `src/transport-http.js` (new): `sendCapture(payload, cfg)`.
- `src/transport-orgproto.js` (new; absorbs `capture-url.js`): `dispatchOrgProtocol(payload, cfg)` (custom `org-clipper` sub-protocol).
- `src/transport.js` (new): selects the front-end from `cfg.transport`.
- `background.js`: `buildCaptureUrlForTab` → `buildCapturePayloadForTab` (returns the JSON object); dispatch via `transport`.
- `popup.js`: drop the hidden-iframe dispatch; background performs the send; popup only renders status.
- `capture-url.js`: folded into `transport-orgproto.js`.
- `options.{html,js}`: add `transport`, `endpoint`, `token`; drop the now-obsolete `subprotocol` (org-protocol transport uses a fixed `org-clipper` sub-protocol).
- `md-to-org.js`: unchanged.

**Emacs (`emacs/org-clipper.el`)**
- New: `org-clipper-transport`, `org-clipper-http-port`, `org-clipper-http-token` (+ token file), `org-clipper-default-tags` (default `("clippings")`).
- New: `org-clipper--insert-clip` (shared core; takes the full payload incl. metadata, generates `:ID:`, writes the metadata drawer), `org-clipper--capture-target-file` (lean persistent buffer — already prototyped), profile registry (default `w`).
- New (http): `org-clipper--http-server`, `org-clipper--http-filter`, `org-clipper-start`, `org-clipper-stop`, `org-clipper-show-token`.
- New (org-protocol): `org-clipper` sub-protocol handler → decode → core.
- **Removed:** `org-clipper-fill-body`, `org-clipper--fill-body-on-finalize`, `:before-finalize`; the old built-in-`capture`/template-`w` registration.
- README: document both transports + the trade-off + the HTTP enable steps.

## 15. Open items / future

- Monthly-file rotation / size cap to bound `save` cost.
- Optional: a `GET /health` endpoint so the extension can show listener status in Options.
- Optional: per-profile target files (multiple `template`s).
