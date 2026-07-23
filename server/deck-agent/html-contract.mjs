export const MODEL_HTML_CONTRACT = Object.freeze({
  allowedTags: Object.freeze([
    "div", "article", "header", "footer", "h1", "h2", "h3", "p", "span", "br",
    "strong", "em", "small", "ul", "ol", "li", "blockquote", "table",
    "thead", "tbody", "tr", "th", "td", "figure", "figcaption", "img",
  ]),
  reservedTags: Object.freeze(["aside", "section"]),
  reservedCssClasses: Object.freeze(["notes"]),
  fallbackContainerTags: Object.freeze(["div", "article"]),
  speakerNotes: "Server-owned metadata only. Never render, paraphrase, hide, or copy speaker notes into HTML, CSS, attributes, comments, asset slots, or charts.",
});
