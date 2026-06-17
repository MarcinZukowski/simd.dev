# SIMD Tooltips — browser extension

Drop-in hover tooltips for SIMD intrinsics and types on any page you
visit. Wraps the simd.dev tooltip library (`simd-tooltip/dist/`) in a
minimal MV3 extension that ships with the database bundled.

## Layout

```
simd-browser-extension/
  manifest.json
  content.js            # reads settings, applies URL filter, calls SimdTooltips.init()
  options.html / .css / .js
  lib/
    simd-tooltips.js    # copied from ../simd-tooltip/dist/
    simd-names.json
    simd-data.json
  README.md
```

Bundling the data files keeps the extension fully offline and avoids
CORS, at the cost of a larger install (~19 MB unpacked). Refresh the
data by rebuilding upstream (`scripts/build_all.sh`) and copying the
three artifacts back into `lib/`.

## Settings

The options page (`chrome://extensions` -> Details -> Extension options,
or `about:addons` in Firefox) exposes:

- **Enabled** — master switch.
- **Show tooltips on SIMD types too** — when off, hovers fire only on
  intrinsic names like `_mm_add_epi32`; types like `__m256i` are ignored.
- **Excluded URLs** — one regex per line. If any pattern matches
  `location.href`, the extension stays inert on that page.

Changes apply to newly loaded pages immediately; for already-open tabs,
storage changes are picked up live (the content script re-inits).

## Install for local development

### Chrome / Chromium / Edge

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. **Load unpacked**, pick this directory.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on**, pick `manifest.json` in this directory.

Temporary in Firefox means the extension is removed on restart.

## Distribution

- **Chrome Web Store**: required for any non-developer install on
  Chrome / Edge. $5 one-time developer fee, automated + manual review
  typically a few days.
- **Firefox AMO**: free. Two modes —
  - *Listed on AMO* (search + install from addons.mozilla.org), or
  - *Self-distribution* (Mozilla signs the `.xpi`, you host it
    anywhere). Either way the `.xpi` must be signed by AMO; unsigned
    builds only load in Developer Edition / Nightly.

Both stores accept the same zipped directory; rename to `.xpi` for AMO
self-distribution.

## Refreshing the bundled database

```sh
# from repo root
scripts/build_all.sh                # rebuild dist artifacts
cp simd-tooltip/dist/simd-tooltips.js  simd-browser-extension/lib/
cp simd-tooltip/dist/simd-names.json   simd-browser-extension/lib/
cp simd-tooltip/dist/simd-data.json    simd-browser-extension/lib/
# bump "version" in manifest.json before publishing
```

## Notes

- No background script. The whole extension runs as a content script +
  options page, which sidesteps Chrome-service-worker vs
  Firefox-event-page differences.
- The content script lives in the isolated world; the tooltip library
  attaches DOM listeners and inserts one `<style>` + one tooltip
  `<div>` into the page. It does not run page-author JS.
- Strict CSP pages still work: only `chrome-extension://` URLs are
  fetched, and no inline `<script>` is injected.
