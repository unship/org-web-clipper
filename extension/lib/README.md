# Vendored third-party libraries

| File          | Source                                                  | Version | License |
| ------------- | ------------------------------------------------------- | ------- | ------- |
| `defuddle.js` | `kepano/defuddle` — `dist/index.full.js` (UMD, full build) | 0.18.1  | MIT     |

Refresh with:

```sh
cp ../../../defuddle/dist/index.full.js ./defuddle.js
```

The UMD prologue assigns the constructor to `window.Defuddle` when loaded as
a classic script (no module/CommonJS environment), which is how the content
script consumes it via `chrome.scripting.executeScript({ files: [...] })`.
