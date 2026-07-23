import crypto from "node:crypto";

export function cspHash(contents) {
  return `sha256-${crypto.createHash("sha256").update(contents).digest("base64")}`;
}

export function buildCsp({ scriptHash, styleHashes, assetOrigin }) {
  const imageSources = ["data:", "blob:", assetOrigin].filter(Boolean).join(" ");
  return [
    "default-src 'none'",
    `script-src '${scriptHash}'`,
    `style-src-elem ${styleHashes.map((hash) => `'${hash}'`).join(" ")}`,
    "style-src-attr 'unsafe-inline'",
    `img-src ${imageSources}`,
    "font-src data:",
    "media-src data:",
    "connect-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "navigate-to 'none'",
  ].join("; ");
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function escapeJsonForHtml(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function buildRuntimeDocument({ title, styles, script, slidesHtml, chartData, assetOrigin }) {
  const safeScript = script.replace(/<\/script/gi, "<\\/script");
  const styleHash = cspHash(styles);
  const scriptHash = cspHash(safeScript);
  const csp = buildCsp({ scriptHash, styleHashes: [styleHash], assetOrigin });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
<title>${escapeHtml(title)}</title>
<style>${styles}</style>
</head>
<body>
<div class="reveal"><div class="slides">${slidesHtml}</div></div>
<template id="deck-chart-data">${escapeJsonForHtml(chartData)}</template>
<div id="deck-speaker-panel" role="status" aria-live="polite"></div>
<script>${safeScript}</script>
</body>
</html>`;
}
