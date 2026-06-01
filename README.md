# org-clipper

A Chrome extension that clips the current web page into an
[Emacs Org-mode](https://orgmode.org/) file. It uses
[Defuddle](https://github.com/kepano/defuddle) for article extraction
(the same engine that powers
[obsidianmd/obsidian-clipper](https://github.com/obsidianmd/obsidian-clipper))
and hands the result to Emacs through a **pluggable transport**. The
default transport opens an `org-protocol://org-clipper?…` URL — exactly
the pattern obsidian-clipper uses with `obsidian://` — so there is no
native-messaging host and no extra process.

> Status: 0.2.0 — pluggable transport (Phase 1). org-protocol is the
> default; an HTTP transport for very long captures is planned for
> Phase 2 (see the [design spec][spec]).

[spec]: docs/design/2026-06-01-pluggable-transport-design.md

## Transports

Clips travel over a transport that **must be configured the same on both
ends** — the extension's `transport` option and Emacs's
`org-clipper-transport`. A mismatch surfaces a clear error rather than
failing silently.

| Transport      | Status            | Trade-off                                                                                  |
| -------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `org-protocol` | **default**       | Zero extra process. The whole body rides inside one URL, so very long pages can be truncated by the OS URL-length limit. |
| `http`         | Phase 2 (opt-in)  | A `127.0.0.1` listener inside Emacs; no truncation, accurate ACK-after-save. See the [spec][spec]. |

Selecting `http` in the extension while Emacs is still on `org-protocol`
(or vice versa) produces an explicit error.

## Capture core

Both transports converge on one shared Emacs core,
`org-clipper--insert-clip`, which:

- writes the clip into a **lean, kept-alive buffer** (`org-mode-hook`
  suppressed) so heavy org-mode / LSP / grammar setup is never re-run
  per clip;
- **prepends** the new entry as the first child of
  `org-clipper-target-headline` (default `Web clips`), newest on top;
- generates an Org `:ID:` and writes a full **metadata drawer** at
  Obsidian-Clipper parity:

```org
** The Article Title  :clippings:research:
:PROPERTIES:
:ID:          A1B2C3D4-...
:SOURCE:      https://example.com/article
:AUTHOR:      David Álvarez Rosa
:PUBLISHED:   2026-03-28
:CREATED:     [2026-05-24 Sun]
:DESCRIPTION: A single-producer single-consumer queue …
:END:

*** First section heading from the article
The article body, with markdown faithfully translated to Org:
*bold*, /italic/, ~code~, [[https://link][links]], lists, src blocks,
quotes, footnotes, and tables.
```

- `:ID:` and `:CREATED:` are always emitted; `:AUTHOR:`, `:PUBLISHED:`
  and `:DESCRIPTION:` only when non-empty. The link property is
  **`:SOURCE:`** (Obsidian-Clipper naming, not the old `:URL:`), and
  `:AUTHOR:` is stored as plain queryable text.
- **`org-clipper-default-tags`** (default `("clippings")`) is always
  merged with the user's tags onto the headline.
- **Heading normalization is owned by Emacs.** The browser emits
  headings at their natural source levels; on insert Emacs re-levels the
  body so the shallowest becomes `clip-level + 1` and nesting is
  *gapless* (an `<h2>` → `<h4>` jump becomes `***` → `****`, never
  `***` → `*****`).

There is **no `org-capture`** machinery and the old fill-on-finalize
feature has been removed; the core itself writes everything the old
capture hooks used to provide.

## Architecture

```
+--------------------+      executeScript       +-------------------------+
|  popup.html / .js  |                          |  Defuddle               |
|  (toolbar UI)      |     -- chrome.* msg -->  |  (vendored UMD bundle,  |
+--------------------+                          |   runs in page world)   |
        |                                       +-------------------------+
        |  { type: "CLIP_TAB", tabId, tags, selectionOnly }       |
        v                                                         | DefuddleResponse
+-----------------------------+              +---------------------------+
| background.js               |              | content-extract.js        |
| (MV3 service worker, ESM)   |              | (IIFE; returns metadata + |
|                             |              |  defuddle's markdown)     |
|  - mdToOrg(...)             |              +---------------------------+
|  - buildCapturePayloadForTab()
|  - dispatchCapture(payload, cfg) --+
+-----------------------------+      |  transport.js selects by cfg.transport:
                                     |    org-protocol -> transport-orgproto.js
                                     |      url = "org-protocol://org-clipper?
                                     |              template=w&url=...&title=...&body=..."
                                     |    http         -> Phase 2
                                     v          (OS routes the protocol)
                       +-----------------------+        +--------------------+
                       |  emacsclient          |  -->   |  Emacs running     |
                       |  (default handler for |        |  org-protocol +    |
                       |   org-protocol://)    |        |  org-clipper       |
                       +-----------------------+        +--------------------+
                                                                  |
                                                  org-clipper--protocol-capture
                                                                  v
                                                        +-------------------+
                                                        |  org-clipper--    |
                                                        |  insert-clip ->   |
                                                        |  target .org file |
                                                        +-------------------+
```

`emacs/org-clipper.el` is the Emacs side. It registers the `org-clipper`
`org-protocol` sub-protocol automatically on `(require 'org-clipper)` and
provides the capture core plus refile/visit helpers.

## Layout

```
extension/
  manifest.json              MV3 manifest
  icons/                     16/48/128 PNG action icons
  lib/defuddle.js            vendored Defuddle 0.18.1 (UMD)
  src/
    background.js            service worker (orchestrates the clip)
    content-extract.js       page-injected Defuddle driver
    md-to-org.js             markdown -> org converter (+ self-tests)
    transport-orgproto.js    builds/dispatches org-protocol://org-clipper URLs (+ self-tests)
    transport.js             transport selector (org-protocol | http) (+ self-tests)
    popup.html / popup.js    toolbar popup UI
    options.html / options.js  settings page
  package.json               type:module marker for node-based tests

emacs/
  org-clipper.el             companion package: capture core + org-protocol handler + refile
  test/org-clipper-test.el   ERT tests (run with emacs --batch)

docs/
  design/                    pluggable-transport design spec
  plans/                     phased implementation plans

GOAL.md                      progress / development log
```

## Install

You need two things: the Chrome extension, and Emacs set up (once) as
the `org-protocol` handler for your OS with `org-clipper.el` loaded.

### 1. Load the Chrome extension (unpacked)

1. Open `chrome://extensions` and enable **Developer mode** (top right).
2. Click **Load unpacked** and select the `extension/` directory.
3. (Optional) Open the extension's **Options** page and tweak the
   default tags, the capture template key, or the transport. Defaults
   (`org-protocol`, template `w`) work out of the box with
   `emacs/org-clipper.el`.

### 2. Make Emacs the `org-protocol://` handler

Inside Emacs:

```elisp
(require 'org-protocol)
(server-start)            ;; or use systemd/launchd to keep an emacs --daemon running
```

`org-protocol` only does anything once it has been required; you also
need an Emacs server running (`server-start`, or a daemon) so
`emacsclient` has somewhere to dispatch to.

Then register Emacs as the OS handler for the `org-protocol` scheme:

#### macOS

Recent `Emacs.app` builds (e.g. from emacsformacosx.com) ship with
`org-protocol` declared in their `Info.plist`. Force Launch Services to
notice it:

```sh
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -kill -r -domain local -domain system -domain user

# Verify Emacs is the registered handler:
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -dump | grep -B2 'org-protocol'
```

If you build Emacs from source without a `.app` wrapper, package it
into a one-file forwarder app (e.g. via Platypus / Automator) whose
`Info.plist` contains:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key>    <string>org-protocol</string>
    <key>CFBundleURLSchemes</key> <array><string>org-protocol</string></array>
  </dict>
</array>
```

…and whose entry point runs:

```sh
emacsclient --no-wait -- "$1"
```

#### Linux

Drop a desktop entry at `~/.local/share/applications/org-protocol.desktop`:

```ini
[Desktop Entry]
Name=Org-Protocol
Exec=emacsclient %u
Type=Application
Terminal=false
Categories=System;
MimeType=x-scheme-handler/org-protocol;
NoDisplay=true
```

…then refresh the MIME database and bind the handler:

```sh
update-desktop-database ~/.local/share/applications
xdg-mime default org-protocol.desktop x-scheme-handler/org-protocol
```

#### Verify

```sh
# macOS:
open "org-protocol://org-clipper?template=w&url=https://example.com&title=Hi&body=Body"

# Linux:
xdg-open "org-protocol://org-clipper?template=w&url=https://example.com&title=Hi&body=Body"
```

With `org-clipper.el` loaded, a new entry should appear under
`* Web clips` in your target file.

### 3. Install the Emacs companion

Put `emacs/org-clipper.el` on your `load-path`, then:

```elisp
(require 'org-clipper)          ;; auto-registers the `org-clipper' sub-protocol
(setq org-clipper-target-file "/Users/you/org/inbox.org")
```

That is all the setup the default transport needs — `(require
'org-clipper)` registers the `org-clipper` entry in
`org-protocol-protocol-alist` for you. There is **no** capture template
to define anymore; the old `org-clipper-register-capture-template` and
the `w` `org-capture` template are gone.

Useful commands and options:

- `M-x org-clipper-visit-target` opens the target file (with
  `auto-revert-mode` so new clips appear without `g`).
- `M-x org-clipper-refile` refiles the most recent clip to another Org
  file via `org-refile`.
- `org-clipper-target-file` — the file clips land in. When `nil`, a
  monthly file (`YYYY-MM.org`) under `org-clipper-monthly-dir` is used.
- `org-clipper-target-headline` (default `Web clips`) — the heading
  clips are prepended under.
- `org-clipper-default-tags` (default `("clippings")`) — always merged
  onto each clip's headline.
- `org-clipper-transport` (default `org-protocol`) — must match the
  extension's `transport`.

## Usage

1. Browse to any article.
2. Click the **org-clipper** toolbar icon.
3. (Optional) Add tags or check **Use page selection only**.
4. Click **Clip page**. The popup will say
   `Sent to Emacs (N,NNN bytes).`
5. The first time, Chrome may ask whether to open the external
   `org-protocol` application; check **Always allow** to skip the
   prompt going forward.
6. In Emacs, your target file now contains a new clip under
   `* Web clips`, with the full `:PROPERTIES:` metadata drawer shown
   above.

A keyboard shortcut for `clip-page` (silent clip without opening the
popup) can be set at `chrome://extensions/shortcuts`.

## Configuration

All settings live in the extension's Options page and persist via
`chrome.storage.sync`.

| Field            | Default        | Meaning                                                                                                       |
| ---------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| Default tags     | (empty)        | Space- or comma-separated tags merged with popup tags (and with Emacs's `org-clipper-default-tags`).          |
| Capture template | `w`            | Selects an org-clipper capture profile in Emacs. No longer an `org-capture-templates` key.                    |
| Transport        | `org-protocol` | How clips reach Emacs. `org-protocol` (default) or `http` (Phase 2). Must match `org-clipper-transport`.      |

Heading levels are normalized in Emacs, so the browser-side heading-shift
option and the org-protocol sub-protocol option are both gone.

## Security model

- Clips travel exclusively over OS-level URL dispatch (org-protocol
  transport). Any local process able to open an `org-protocol://` URL
  (just like `obsidian://`, `slack://`, `zoommtg://`, etc.) can trigger
  Emacs to file a clip. Treat that the way you treat any custom scheme
  handler.
- The extension only opens URLs it constructed itself in the service
  worker, with fields taken from the page Defuddle extracted and the
  user's options. No external network host, no executable spawned by
  the extension, no persistent local server (the HTTP transport, when it
  lands in Phase 2, binds `127.0.0.1` only and is gated by a shared
  token — see the [spec][spec]).
- The capture core runs *inside Emacs* and writes only to the
  configured target file. The payload is treated as data, never code —
  `url`/`title`/`body`/`tags` are inserted as literal text and nothing
  from the request is `eval`'d.
- The dispatch tab created by `chrome.tabs.create({active:false})` is
  closed about a second after the OS hands the URL off, so the user's
  tab strip stays clean.
- Body content is URL-encoded; very long articles produce long URLs.
  Most OS protocol dispatchers handle several hundred KB, but if you
  routinely clip multi-MB pages, switch to the HTTP transport (Phase 2)
  to avoid truncation.

## Development and testing

```sh
# Extension self-tests (Node)
cd extension && node src/md-to-org.js          # markdown -> org
cd extension && node src/transport-orgproto.js # org-protocol URL build/round-trip
cd extension && node src/transport.js          # transport selector

# Emacs ERT tests (batch)
emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit

# byte-compile the elisp
emacs --batch -L emacs -f batch-byte-compile emacs/org-clipper.el
```

To refresh the vendored Defuddle bundle:

```sh
cp ../defuddle/dist/index.full.js extension/lib/defuddle.js
# bump the version in extension/lib/README.md
```

## Acknowledgments

- [Defuddle](https://github.com/kepano/defuddle) by Stephan Ango
  (kepano) — the article extractor that does all the heavy lifting.
- [obsidian-clipper](https://github.com/obsidianmd/obsidian-clipper) —
  the UX inspiration for the popup + URL-handler handoff pattern, and
  for the metadata-drawer parity.
- [org-protocol](https://orgmode.org/worg/org-contrib/org-protocol.html)
  — the long-standing Emacs convention this design is built on.

## License

MIT.
