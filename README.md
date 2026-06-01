# org-clipper

A Chrome extension that clips the current web page into an
[Emacs Org-mode](https://orgmode.org/) file. It uses
[Defuddle](https://github.com/kepano/defuddle) for article extraction
(the same engine that powers
[obsidianmd/obsidian-clipper](https://github.com/obsidianmd/obsidian-clipper))
and hands the result to Emacs via an `org-protocol://capture` URL —
exactly the pattern obsidian-clipper uses with `obsidian://`.

> Status: 0.2.0 — pure Chrome + org-protocol design; no native messaging
> host, no extra processes.

## Architecture

```
+--------------------+      executeScript       +-------------------------+
|  popup.html / .js  |                          |  Defuddle              |
|  (toolbar UI)      |     -- chrome.* msg -->  |  (vendored UMD bundle, |
+--------------------+                          |   runs in page world)  |
        |                                       +-------------------------+
        |  { type: "CLIP_TAB", tabId, tags, selectionOnly }       |
        v                                                         | DefuddleResponse
+-----------------------------+              +---------------------------+
| background.js               |              | content-extract.js        |
| (MV3 service worker, ESM)   |              | (IIFE; returns metadata + |
|                             |              |  defuddle's markdown)     |
|  - mdToOrg(...)             |              +---------------------------+
|  - buildCaptureUrl(...)     |
|  - chrome.tabs.create(...)  |--+
+-----------------------------+  |  url = "org-protocol://capture?
                                 |          template=w&url=...&title=...&body=..."
                                 |
                                 v          (OS routes the protocol)
                       +-----------------------+        +--------------------+
                       |  emacsclient          |  -->   |  Emacs running     |
                       |  (default handler for |        |  org-protocol +    |
                       |   org-protocol://)    |        |  org-capture       |
                       +-----------------------+        +--------------------+
                                                                  |
                                                                  v
                                                        +-------------------+
                                                        |  your target      |
                                                        |  .org file        |
                                                        |  (template `w`)   |
                                                        +-------------------+
```

`emacs/org-clipper.el` is **optional** — it just bundles a starter
`org-capture` template and a couple of refile/visit helpers. With your
own template you do not need it at all.

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
    capture-url.js           builds org-protocol://capture URLs (+ self-tests)
    popup.html / popup.js    toolbar popup UI
    options.html / options.js  settings page
  package.json               type:module marker for node-based tests

emacs/
  org-clipper.el             companion package: starter template + refile

GOAL.md                      progress / development log
```

## Install

The extension is the only required piece. Emacs needs to be set up
(once) as the `org-protocol` handler for your OS, and the companion
package is optional polish.

### 1. Load the Chrome extension (unpacked)

1. Open `chrome://extensions` and enable **Developer mode** (top right).
2. Click **Load unpacked** and select the `extension/` directory.
3. (Optional) Open the extension's **Options** page and tweak the
   capture template key, default tags, heading shift, or the
   `org-protocol` sub-protocol. Defaults work fine if you use the
   starter template from `emacs/org-clipper.el`.

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
open "org-protocol://capture?template=w&url=https://example.com&title=Hi&body=Body"

# Linux:
xdg-open "org-protocol://capture?template=w&url=https://example.com&title=Hi&body=Body"
```

If you have a `w` template, an `org-capture` invocation should happen
in Emacs.

### 3. (Optional) Install the Emacs companion

Put `emacs/org-clipper.el` on your `load-path`, then:

```elisp
(require 'org-clipper)
(setq org-clipper-target-file "/Users/you/org/inbox.org"
      org-clipper-capture-template-key "w")  ; matches the extension's setting

(org-clipper-register-capture-template)        ; registers `w' for you
```

Now:

- `M-x org-clipper-visit-target` opens the target file (with
  `auto-revert-mode` so new clips appear without `g`).
- `M-x org-clipper-refile` refiles the most recent clip to another Org
  file via `org-refile`.

If you would rather hand-roll the template, the relevant placeholders
populated by the built-in `capture` sub-protocol are:

| Placeholder       | Value                                              |
| ----------------- | -------------------------------------------------- |
| `%:link`          | the page URL                                       |
| `%:description`   | the page title, with `:tag:` suffix from extension |
| `%i`              | the converted Org body (`org-protocol` "initial")  |

## Usage

1. Browse to any article.
2. Click the **org-clipper** toolbar icon.
3. (Optional) Add tags or check **Use page selection only**.
4. Click **Clip page**. The popup will say
   `Handed off to Emacs (N,NNN bytes).`
5. The first time, Chrome may ask whether to open the external
   `org-protocol` application; check **Always allow** to skip the
   prompt going forward.
6. In Emacs, your target file now contains a new top-level headline:

```org
* The Article Title  :webclip:research:
:PROPERTIES:
:URL:       https://example.com/article
:CAPTURED:  [2026-05-24 Sun 11:00]
:END:

** First section heading from the article
The article body, with markdown faithfully translated to Org:
*bold*, /italic/, ~code~, [[https://link][links]], lists, src blocks,
quotes, footnotes, and tables.
```

A keyboard shortcut for `clip-page` (silent clip without opening the
popup) can be set at `chrome://extensions/shortcuts`.

## Configuration

All settings live in the extension's Options page and persist via
`chrome.storage.sync`.

| Field            | Default     | Meaning                                                                                                       |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| Default tags     | (empty)     | Space- or comma-separated tags merged with popup tags; appended to the title as Org's `:tag:` suffix.         |
| Capture template | `w`         | `org-capture-templates` key Emacs uses when handling the URL. Must match the template you have configured.    |
| Heading shift   | `1`         | Added to every body heading so they nest below the outer clip heading.                                        |
| Sub-protocol     | `capture`   | Path used in `org-protocol://<sub>?…`. Built-in `capture` is the right choice unless you have a custom one.   |

## Security model

- Clips travel exclusively over OS-level URL dispatch.  Any local
  process able to open an `org-protocol://` URL (just like
  `obsidian://`, `slack://`, `zoommtg://`, etc.) can trigger Emacs to
  run an `org-capture` template.  Treat that the way you treat any
  custom scheme handler.
- The extension only opens URLs it constructed itself in the service
  worker, with fields taken from the page Defuddle extracted and the
  user's options. No external network host, no executable spawned by
  the extension, no persistent local server.
- The starter `org-capture` template runs *inside Emacs* and writes only
  to `org-clipper-target-file`. Audit it the way you would any other
  capture template — `org-capture-templates` is the source of truth.
- The dispatch tab created by `chrome.tabs.create({active:false})` is
  closed about 800 ms after the OS hands the URL off, so the user's
  tab strip stays clean.
- Body content is URL-encoded; very long articles produce long URLs.
  Most OS protocol dispatchers handle several hundred KB, but if you
  routinely clip multi-MB pages, expect truncation. The service
  worker logs a warning to its devtools console when a URL exceeds
  150 KB.

## Development and testing

```sh
# md-to-org self-tests (12 cases)
cd extension && node src/md-to-org.js

# capture-url self-tests (9 cases)
cd extension && node src/capture-url.js

# byte-compile the elisp
emacs --batch -f batch-byte-compile emacs/org-clipper.el
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
  the UX inspiration for the popup + URL-handler handoff pattern.
- [org-protocol](https://orgmode.org/worg/org-contrib/org-protocol.html)
  — the long-standing Emacs convention this design is built on.

## License

MIT.
