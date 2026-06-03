# Vendored third-party libraries

| File          | Source                                                  | Version | License |
| ------------- | ------------------------------------------------------- | ------- | ------- |
| `defuddle.js` | `kepano/defuddle` — `dist/index.full.js` (UMD, full build) | 0.18.1  | MIT     |

`defuddle` is pinned in `extension/package.json` and locked (version + integrity
hash) in `extension/package-lock.json`, so npm fetches the genuine published
artifact and the vendored bundle can't silently drift. Refresh by bumping the
pinned version, then letting npm fetch it and copying it into place:

```sh
cd extension
# (edit "defuddle" in package.json to the new version first)
npm install              # updates package-lock.json (locks version + integrity)
npm run vendor:defuddle  # cp node_modules/defuddle/dist/index.full.js -> lib/defuddle.js
shasum -a 256 lib/defuddle.js
# expect (0.18.1): 2016f46bbd39d7e0b3a91cc1fe6067523638e181773918f1a1f92b2d592f463c
```

Do **not** `cp` from a local `../../../defuddle` checkout — that silently vendored
a stale, unreleased build once (see note below).

> History: a previously vendored `defuddle.js` was a different, older-behaving
> build mislabeled `0.18.1` (901 KB vs the genuine 704 KB). It still carried the
> pre-0.16 footnote collector that deletes the whole article body when footnote
> definitions sit loose in the content — e.g. Zola/mdBook `div.footnote-definition`
> siblings, as on <https://joshlf.com/posts/memory-safety-life-and-death/>, which
> clipped as nothing but footnotes. Genuine 0.18.1 (fixed since 0.16.0) handles it.
> Always verify the sha256 after refreshing.

The UMD prologue assigns the constructor to `window.Defuddle` when loaded as
a classic script (no module/CommonJS environment), which is how the content
script consumes it via `chrome.scripting.executeScript({ files: [...] })`.
