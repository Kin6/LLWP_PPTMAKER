# Source Provenance

Treat normalized source blocks as the only valid source namespace. Extract IDs only from `<!-- source:block-id -->` comments in the validated outline and reject any ID absent from the supplied source-block set.

For each slide:

1. Preserve the stable ID `slide-NN` and write the fragment as `slide-NN.html`.
2. Record a top-level `sourceRefs` array on the corresponding `process.json` slide record.
3. Deduplicate repeated references without changing their first-seen order.
4. Keep every source ID visible inside the fragment's `data-slot="source"` region, but leave `data-slide-root`, `data-slide-id`, and `data-source-refs` to the assembler.

Use this machine-readable shape:

```json
{
  "slides": [
    { "slideId": "slide-01", "sourceRefs": ["block-018"] },
    { "slideId": "slide-02", "sourceRefs": ["block-031"] }
  ],
  "imageFallbacks": []
}
```

An image position is a structured `data-asset-slot` in a fragment. Use `<img src="asset://id">` only after the local media matcher accepts the catalog entry and verifies its file hash. When no approved image exists, keep or omit the structured slot according to the layout and do not substitute a remote image, data URL, CSS URL, emoji illustration, or invented source. Keep `imageFallbacks` empty.

The local media catalog begins empty. Accept a future catalog entry only when it has all fields `{ id, file, tags, license, sourceUrl, sha256 }` and the file hash matches `sha256`; otherwise ignore it.
