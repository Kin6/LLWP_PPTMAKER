# Design Direction

Commit to one direction before writing slide fragments. Do not present variants or mix visual systems. Record the chosen direction as one non-empty `designDirection` string in `process.json`. Do not emit the plural `designDirections` alias, even alongside the canonical field.

Define the direction with a concrete name, audience posture, information hierarchy, palette roles, type roles, spacing rhythm, and graphic treatment. Choose exactly one theme from `assets/catalog.json`; use its `--deck-*` tokens without renaming them. Prefer restrained combinations of neutral surfaces, a functional accent, and a distinct evidence or warning color.

## CSS Contract

Use one shared CSS file:

```css
:root {
  --deck-custom-token: value;
}

:slide {
  box-sizing: border-box;
  width: 1920px;
  height: 1080px;
  overflow: hidden;
}

:slide .component { /* local component rules */ }
```

Every selector other than a token-only `:root` rule must begin with `:slide`. Prefix descendant, pseudo-element, and state selectors too. Do not use global element selectors, `*`, `html`, `body`, `.slide`, imports, or font-face rules. Keep letter spacing at `0`; do not scale type with viewport width.

The service supplies the actual slide root when it assembles the deck. Page fragments therefore contain only the root's children and never declare `data-slide-root` themselves.
