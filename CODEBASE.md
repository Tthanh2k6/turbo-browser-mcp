# Codebase notes

## Element reference fingerprints

`src/dom-engine.mjs` stores fingerprints during `inspectCompact` and checks them
before acting on references. `computeElementFingerprintInBrowser` and the inline
`fingerprintOf` callbacks in `inspectCompact` and `smartFillForm` must stay identical;
`test/round22.test.mjs` checks their source parity.

Value controls use identity attributes and label text, excluding their current
value. Matching clones also include their position and group size so a same-size
swap is refused. Live counters are masked in descriptive text. A trailing title
shortcut such as `[f]` or `[alt-shift-f]` is excluded only when its key matches the
control's `accesskey`; this tolerates Wikipedia's hydration without ignoring the
rest of the title or unrelated bracketed text.

`test/night-19-11-wiki-search.test.mjs` uses local main/sticky search forms, hidden
title inputs, labels and shortcut hydration to verify inspect/evaluate/type/form
fill, meaningful identity changes, and clone swaps. Run `npm test` for the full
suite.

## 9. Documentation changelog

- 2026-11-19: Documented accesskey title normalization and the Wikipedia regression fixture.
