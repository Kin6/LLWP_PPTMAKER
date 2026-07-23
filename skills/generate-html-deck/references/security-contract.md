# Security Contract

Produce inert, offline slide fragments and one scoped stylesheet.

## Fragment Rules

- Do not emit `<script>` or `<style>` elements.
- Do not emit `<form>`, `<frame>`, `<iframe>`, `<embed>`, or `<object>` elements, or any SVG or MathML element.
- Do not emit event-handler, `srcdoc`, or inline `style` attributes, or `javascript:` values.
- Do not emit `href`, `srcset`, `action`, `poster`, or `formaction` URLs. An `<img>` may use `src="asset://id"` only when the local media catalog entry has every required field and its file matches the recorded SHA-256; the empty initial catalog therefore permits no image URL.
- Do not declare the service-owned slide root or its ID/source attributes.
- Use semantic elements plus named `data-slot` and `data-asset-slot` attributes only.

## Stylesheet Rules

- Use a token-only `:root` rule whose custom properties all start with `--deck-`.
- Prefix every other selector with `:slide`.
- Set the `:slide` canvas to exactly `1920px` by `1080px` and hide overflow.
- Do not use `@import`, external `url()`, remote fonts, viewport-relative canvas sizing, scripts, or CSS capable of network access.

## Execution Boundary

Do not install packages, start an editor server, execute generated code, use a CDN, or run an upstream repository's scripts. The service parses fragments, resolves approved local assets, owns the root element, and packages the standalone deck.
