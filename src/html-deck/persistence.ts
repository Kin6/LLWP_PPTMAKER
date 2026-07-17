import { openDB } from "idb";
import type { HtmlDeckSpec } from "./types";

const databaseName = "llwp-html-decks";
const storeName = "decks";
const saveQueues = new Map<string, Promise<void>>();

async function database() {
  return openDB(databaseName, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: "id" });
    },
  });
}

export function saveHtmlDeck(deck: HtmlDeckSpec) {
  const previous = saveQueues.get(deck.id) || Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const portable = await makePersistent(deck);
    const db = await database();
    const transaction = db.transaction(storeName, "readwrite");
    const existing = await transaction.store.get(deck.id) as (HtmlDeckSpec & { savedAt?: string }) | undefined;
    if (!existing || existing.revision <= deck.revision) {
      await transaction.store.put({ ...portable, savedAt: new Date().toISOString() });
    }
    await transaction.done;
  });
  saveQueues.set(deck.id, next);
  const cleanup = () => {
    if (saveQueues.get(deck.id) === next) saveQueues.delete(deck.id);
  };
  void next.then(cleanup, cleanup);
  return next;
}

export async function loadHtmlDeck(id: string) {
  const db = await database();
  return db.get(storeName, id) as Promise<(HtmlDeckSpec & { savedAt?: string }) | undefined>;
}

export async function listHtmlDecks() {
  const db = await database();
  return db.getAll(storeName) as Promise<Array<HtmlDeckSpec & { savedAt?: string }>>;
}

async function makePersistent(deck: HtmlDeckSpec): Promise<HtmlDeckSpec> {
  return {
    ...deck,
    slides: await Promise.all(deck.slides.map(async (slide) => ({
      ...slide,
      nodes: await Promise.all(slide.nodes.map(async (node) => {
        if ((node.type === "image" || node.type === "video") && node.src.startsWith("blob:")) {
          try { return { ...node, src: await urlToDataUri(node.src) }; } catch { return node; }
        }
        return node;
      })),
    }))),
  };
}

async function urlToDataUri(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("无法保存演示素材。");
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取演示素材。"));
    reader.readAsDataURL(blob);
  });
}
