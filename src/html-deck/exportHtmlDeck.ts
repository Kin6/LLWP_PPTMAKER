import { buildHtmlDeckDocument } from "./document";
import type { HtmlDeckSpec, HtmlImageNode, HtmlVideoNode } from "./types";

export async function exportStandaloneHtmlDeck(deck: HtmlDeckSpec) {
  const [revealCss, revealJs, echartsJs, portableDeck] = await Promise.all([
    fetchText("/api/html-runtime/reveal.css"),
    fetchText("/api/html-runtime/reveal.js"),
    fetchText("/api/html-runtime/echarts.js"),
    makeDeckPortable(deck),
  ]);
  const document = buildHtmlDeckDocument(portableDeck, {
    runtimeOrigin: window.location.origin,
    editMode: false,
    inlineVendors: { revealCss, revealJs, echartsJs },
  });
  downloadBlob(new Blob([document], { type: "text/html;charset=utf-8" }), `${sanitizeFileName(deck.title)}-interactive.html`);
}

async function makeDeckPortable(deck: HtmlDeckSpec): Promise<HtmlDeckSpec> {
  const slides = await Promise.all(deck.slides.map(async (slide) => ({
    ...slide,
    nodes: await Promise.all(slide.nodes.map(async (node) => {
      if ((node.type === "image" || node.type === "video") && node.src.startsWith("blob:")) {
        return { ...node, src: await urlToDataUri(node.src) } as HtmlImageNode | HtmlVideoNode;
      }
      return node;
    })),
  })));
  return { ...deck, slides };
}

async function fetchText(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`无法读取 HTML 运行时资源：${url}`);
  return response.text();
}

async function urlToDataUri(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("无法打包演示素材。");
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取演示素材。"));
    reader.readAsDataURL(blob);
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

function sanitizeFileName(value: string) {
  return value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 80) || "interactive-deck";
}
