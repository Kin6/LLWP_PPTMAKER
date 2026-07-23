# Security Contract

Produce inert, offline slide fragments and one scoped stylesheet.

## Fragment Rules

- Do not emit `<script>` or `<style>` elements.
- Emit rootless fragments only. Do not emit a doctype or `<html>`, `<head>`, or `<body>` wrappers.
- Do not emit `<form>`, `<frame>`, `<iframe>`, `<embed>`, or `<object>` elements, or any SVG or MathML element.
- Do not emit event-handler, `srcdoc`, or inline `style` attributes, or `javascript:` values.
- Do not emit URL-bearing attributes `action`, `archive`, `attributionsrc`, `background`, `cite`, `classid`, `codebase`, `data`, `dynsrc`, `formaction`, `href`, `imagesrcset`, `itemid`, `itemtype`, `longdesc`, `lowsrc`, `manifest`, `ping`, `poster`, `profile`, `src`, `srcset`, `usemap`, or `xlink:href`. The only HTML-attribute exception is `<img src="asset://id">` when the local media catalog entry has every required field and its file matches the recorded SHA-256; `asset://` is forbidden in every other URL-bearing attribute. The empty initial catalog therefore permits no image URL.
- Do not declare the service-owned slide root or its ID/source attributes.
- Treat the runtime `htmlContract.allowedTags` array as the complete model HTML allowlist; every unlisted tag is forbidden even when it is otherwise semantic or inert.
- Do not emit `<section>` or target it in CSS. Reveal owns that element for slide navigation; use `<div>` or `<article>` as generated content containers.
- Tags in `htmlContract.reservedTags` and class names in `htmlContract.reservedCssClasses` are service-owned and must never appear in model HTML or CSS selectors. In particular, the renderer owns `<aside class="notes">`.
- Speaker notes and `讲稿提示` remain server-owned metadata. Never render, paraphrase, hide, or copy them into HTML, CSS, attributes, comments, asset slots, or charts.
- Use named `data-slot` and `data-asset-slot` attributes only on allowed elements.

## Stylesheet Rules

- The service owns the locked theme stylesheet and its token-only `:root` rule. Never emit `:root` or custom-property declarations in a per-slide `css` field.
- Every comma-separated selector branch in per-slide CSS must start exactly with `:slide`; repeat `:slide` after every comma. Valid: `:slide header, :slide footer { ... }`. Invalid: `:slide header, footer { ... }`.
- Root variants such as `:slide:first-child`, descendant attribute selectors such as `[data-slot]`, IDs, and pseudo-elements are invalid. Add explicit classes to the generated HTML when elements need distinct styling, then select those classes beneath `:slide`.
- The server-owned `:slide` root is an unpadded `1920px` by `1080px` canvas. Keep it at that exact size with `overflow: hidden`, and apply the `72px` safe inset exactly once in the generated composition rather than stacking nested full-canvas padding.
- Do not use any CSS at-rule, external `url()`, remote fonts, viewport-relative canvas sizing, scripts, or CSS capable of network access.

## Execution Boundary

Do not install packages, start an editor server, execute generated code, use a CDN, or run an upstream repository's scripts. The service parses fragments, resolves approved local assets, owns the root element, and packages the standalone deck.
