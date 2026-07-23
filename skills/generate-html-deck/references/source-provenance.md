# Source Provenance

Treat normalized source blocks as the only valid source namespace. Extract IDs only from `<!-- source:block-id -->` comments in the validated outline and reject any ID absent from the supplied source-block set.

## No External Materials

When the supplied source-block set is empty, the deck is in topic-only mode. Keep the human-readable `材料来源` section on every slide and state that no external material was provided, the content uses model general knowledge, and important facts require verification. Do not emit a `source:` comment, invent a source ID, filename, page number, citation, or URL. Store `sourceRefs` as an empty array and preserve that empty array through rendering and verification.

When one or more source blocks are supplied, topic-only mode is disabled: every slide must retain at least one valid source comment and every referenced ID must exist in the supplied source-block set.

For each slide:

1. Preserve the stable ID `slide-NN` and write the fragment as `slide-NN.html`.
2. Record a top-level `sourceRefs` array on the corresponding `process.json` slide record.
3. Deduplicate repeated references without changing their first-seen order.
4. Keep every source ID visible inside the fragment's `data-slot="source"` region, but leave `data-slide-root`, `data-slide-id`, and `data-source-refs` to the assembler.

Visible source evidence must not be hidden by CSS. Do not use `display: none`, `visibility: hidden`, `visibility: collapse`, `opacity: 0`, `color: transparent`, `font-size: 0`, `content-visibility: hidden`, `clip`, `clip-path`, or a `transform` containing `scale(0)` on source evidence or elsewhere in the fixed offline slide stylesheet.

Use this machine-readable shape:

```json
{
  "imageResolutionOrder": ["uploaded-assets", "licensed-internal-assets", "optional-generation", "no-image-layout"],
  "optionalImageFailures": [],
  "slides": [
    { "slideId": "slide-01", "sourceRefs": ["block-018"] },
    { "slideId": "slide-02", "sourceRefs": ["block-031"] }
  ],
  "imageFallbacks": []
}
```

An image position is a structured `data-asset-slot` in a fragment. Resolve each slot in this exact `imageResolutionOrder`: `uploaded-assets`, `licensed-internal-assets`, `optional-generation`, `no-image-layout`. Record that four-item array in `process.json`. Uploaded source assets come first; the licensed internal catalog is second; generation is optional and third. A missing or failed optional image must not fail the deck: record `{ "slot": "slot-name", "outcome": "no-image-layout" }` in `optionalImageFailures`, select a no-image layout, and continue. Each `optionalImageFailures` record must have exactly those two fields, use a unique slot name, and map to a matching empty named `data-asset-slot`; do not emit duplicate optional image failure records. Keep every decided image position as an empty named `data-asset-slot` when resolution ends in `no-image-layout`; every matching fallback slot must remain structurally empty. Do not add an `<img>` or add a URL, text, or another element.

Use `<img src="asset://id">` only after the selected local asset passes its provenance and hash checks. When no approved image exists, leave the required structured slot empty and do not substitute a remote image, data URL, CSS URL, emoji illustration, invented asset, or fake image fallback. Keep `imageFallbacks` empty.

The local media catalog begins empty. Accept a future catalog entry only when it has all fields `{ id, file, tags, license, sourceUrl, sha256 }` and the file hash matches `sha256`; otherwise ignore it.
