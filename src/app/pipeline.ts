import { coverImageRect } from "../lib/imageGeometry";
import { generateAiImages, type ApiConfig, type ApiSourceImage, type DeckSource, type ImageJob } from "../lib/apiClient";
import type { ExtractedBlock } from "../lib/attachmentParser";
import { parseTable } from "../lib/localPlanner";
import type { GeneratedAsset, NotebookDeckSpec } from "../types";
import type { StepId } from "./workflow";

export type GenerationSource = {
  topic: string;
  audience: string;
  slideCount: number;
  textInput: string;
  tableInput: string;
  imageBrief: string;
  styleId: string;
  assets: GeneratedAsset[];
  sourceBlocks?: ExtractedBlock[];
};

export type PipelineCheckpoint = {
  source: GenerationSource;
  config: ApiConfig;
  sourceImages: ApiSourceImage[];
  sourceUploads: GeneratedAsset[];
  deck?: NotebookDeckSpec;
  assets: GeneratedAsset[];
  generatedBySlide: Record<number, GeneratedAsset>;
  requestedImageCount: number;
  resumeFrom: StepId;
};

type ImageStageProgress = {
  deck: NotebookDeckSpec;
  assets: GeneratedAsset[];
  generatedBySlide: Record<number, GeneratedAsset>;
  apiCalls: number;
  slideIndex: number;
  requestedImageCount: number;
};

type ImageStageOptions = {
  deck: NotebookDeckSpec;
  config: ApiConfig;
  requestConfig?: ApiConfig;
  sourceUploads: GeneratedAsset[];
  sourceImages: ApiSourceImage[];
  styleId: string;
  generatedBySlide: Record<number, GeneratedAsset>;
  requestedImageCount: number;
  textMode: ApiConfig["imageTextMode"];
  assetIdPrefix: string;
  filenamePrefix: string;
  summary: (slideIndex: number) => string;
  activityMessage: (slideIndex: number, total: number) => string;
  onJobStart: (slideIndex: number, total: number, completed: number) => void;
  runWithActivity: <T>(message: string, task: () => Promise<T>) => Promise<T>;
  onJobComplete: (progress: ImageStageProgress) => void;
  requestError?: (error: unknown, slideIndex: number, total: number) => Error;
  missingImageError?: (slideIndex: number, total: number) => Error;
};

export const defaultApiConfig: ApiConfig = {
  configVersion: 6,
  imageEnabled: true,
  imageCount: 0,
  imageQuality: "high",
  imageTextMode: "integrated",
  imageTimeoutSeconds: 600,
  imageMaxRetries: 1,
};

export function toDeckSource(source: GenerationSource, images: ApiSourceImage[]): DeckSource {
  return {
    topic: source.topic,
    audience: source.audience,
    slideCount: source.slideCount,
    textInput: source.textInput,
    tableInput: source.tableInput,
    imageBrief: source.imageBrief,
    styleId: source.styleId,
    images,
    sourceBlocks: source.sourceBlocks || [],
  };
}

export async function runImageGenerationStage(options: ImageStageOptions) {
  const {
    config,
    sourceUploads,
    sourceImages,
    styleId,
    generatedBySlide,
    requestedImageCount,
    textMode,
  } = options;
  const jobs = createImageJobs(options.deck, requestedImageCount, textMode);
  let nextDeck = options.deck;
  let nextAssets = [...sourceUploads, ...orderedGeneratedAssets(generatedBySlide)];

  for (const job of jobs) {
    if (generatedBySlide[job.slideIndex]) continue;
    const completed = Object.keys(generatedBySlide).length;
    options.onJobStart(job.slideIndex, requestedImageCount, completed);
    let response;
    try {
      response = await options.runWithActivity(
        options.activityMessage(job.slideIndex, requestedImageCount),
        () => generateAiImages(options.requestConfig || config, [job], sourceImages, styleId),
      );
    } catch (error) {
      throw options.requestError?.(error, job.slideIndex, requestedImageCount) || error;
    }
    if (response.images.length !== 1) {
      throw options.missingImageError?.(job.slideIndex, requestedImageCount)
        || new Error(`第 ${job.slideIndex + 1}/${requestedImageCount} 页没有返回完整图片`);
    }
    const image = await normalizeGeneratedSlideImage(response.images[0]);
    const generatedAsset: GeneratedAsset = {
      id: makeId(options.assetIdPrefix),
      filename: `${options.filenamePrefix}-${image.slideIndex + 1}.png`,
      url: image.url,
      prompt: image.prompt,
      index: maxAssetIndex([...sourceUploads, ...orderedGeneratedAssets(generatedBySlide)]) + 1,
      kind: "generated",
      width: image.width,
      height: image.height,
      summary: options.summary(image.slideIndex),
    };
    generatedBySlide[image.slideIndex] = generatedAsset;
    nextAssets = [...sourceUploads, ...orderedGeneratedAssets(generatedBySlide)];
    nextDeck = applyGeneratedAssets(nextDeck, generatedBySlide, textMode);
    options.onJobComplete({
      deck: nextDeck,
      assets: nextAssets,
      generatedBySlide,
      apiCalls: response.meta.apiCalls,
      slideIndex: image.slideIndex,
      requestedImageCount,
    });
  }

  return { deck: nextDeck, assets: nextAssets, generatedBySlide };
}

export function orderedGeneratedAssets(generatedBySlide: Record<number, GeneratedAsset>) {
  return Object.entries(generatedBySlide)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, asset]) => asset);
}

export function imageProgressDetail(generatedBySlide: Record<number, GeneratedAsset>, total: number) {
  const completed = orderedGeneratedAssets(generatedBySlide).length;
  return completed
    ? `已保存 ${completed}/${total} 页；下一页失败时可从当前进度继续`
    : `准备逐页生成 ${total} 页，每成功一页立即保存检查点`;
}

export function applyGeneratedAssets(
  deck: NotebookDeckSpec,
  generatedBySlide: Record<number, GeneratedAsset>,
  textMode: ApiConfig["imageTextMode"],
) {
  return {
    ...deck,
    slides: deck.slides.map((slide, index) => {
      const asset = generatedBySlide[index];
      return asset ? {
        ...slide,
        imageIndex: asset.index,
        visualMode: textMode === "integrated" ? "full-slide-text" as const : "panel" as const,
      } : slide;
    }),
  };
}

export function createImageJobs(deck: NotebookDeckSpec, count: number, textMode: ApiConfig["imageTextMode"]): ImageJob[] {
  return deck.slides.slice(0, clamp(count, 1, 50)).map((slide, slideIndex) => ({
    slideIndex,
    prompt: [
      `页面观点：${slide.title}`,
      slide.claim ? `核心结论：${slide.claim}` : "",
      slide.bullets?.length ? `支撑要点：${slide.bullets.slice(0, 5).join("；")}` : "",
      `视觉任务：${slide.imagePrompt || slide.visualBrief || slide.title}`,
    ].filter(Boolean).join("\n"),
    layout: slide.layout || "visual-right",
    deckTitle: deck.title,
    title: slide.title,
    subtitle: slide.subtitle || "",
    claim: slide.claim || "",
    bullets: (slide.bullets || []).slice(0, 5),
    callouts: (slide.callouts || []).slice(0, 3),
    tableRows: (slide.tableRows || []).slice(0, textMode === "integrated" ? 4 : 5).map((row) => row.slice(0, textMode === "integrated" ? 3 : 4)),
    pageNumber: slideIndex + 1,
    totalPages: deck.slides.length,
    textMode,
    deckThesis: deck.story.thesis,
    audienceInsight: deck.story.audienceInsight,
    narrativeArc: deck.story.narrativeArc,
    previousSlideTitle: deck.slides[slideIndex - 1]?.title || "",
    nextSlideTitle: deck.slides[slideIndex + 1]?.title || "",
  }));
}

export function attachEditableTable(deck: NotebookDeckSpec, tableInput: string) {
  const rows = parseTable(tableInput);
  if (rows.length < 2) return deck;
  const target = Math.min(2, deck.slides.length - 1);
  return { ...deck, slides: deck.slides.map((slide, index) => index === target ? { ...slide, tableRows: rows.slice(0, 7).map((row) => row.slice(0, 5)) } : slide) };
}

export function remapUploadedImageIndexes(deck: NotebookDeckSpec, uploads: GeneratedAsset[]) {
  return {
    ...deck,
    slides: deck.slides.map((slide) => {
      if (slide.imageIndex == null) return slide;
      const upload = uploads[slide.imageIndex - 1];
      return { ...slide, imageIndex: upload?.index };
    }),
  };
}

export async function assetToApiImage(asset: GeneratedAsset): Promise<ApiSourceImage> {
  const image = await loadImage(asset.url);
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法处理参考图片。");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { name: asset.filename, dataUrl: canvas.toDataURL("image/jpeg", 0.86), summary: asset.summary || asset.prompt };
}

export async function normalizeGeneratedSlideImage(image: { slideIndex: number; url: string; prompt: string; revisedPrompt?: string }) {
  const source = await loadImage(image.url);
  const targetRatio = 16 / 9;
  const sourceRatio = source.naturalWidth / Math.max(1, source.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = 1536;
  canvas.height = Math.round(canvas.width / targetRatio);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法整理 Image 2 页面画布。");

  if (Math.abs(sourceRatio - targetRatio) < 0.01) {
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
  } else {
    const fullBleed = coverImageRect(source.naturalWidth, source.naturalHeight, canvas.width, canvas.height);
    context.drawImage(source, fullBleed.x, fullBleed.y, fullBleed.width, fullBleed.height);
  }
  return { ...image, url: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
}

export async function inspectImage(file: File, index: number, brief: string): Promise<GeneratedAsset> {
  const url = URL.createObjectURL(file);
  const image = await loadImage(url);
  const orientation = image.naturalWidth / Math.max(image.naturalHeight, 1) > 1.25 ? "横图" : image.naturalHeight > image.naturalWidth ? "竖图" : "方图";
  return { id: makeId("upload"), filename: file.name, url, prompt: brief, index, kind: "upload", width: image.naturalWidth, height: image.naturalHeight, summary: `${image.naturalWidth}×${image.naturalHeight} ${orientation}，用户内容参考` };
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取图片。"));
    image.src = url;
  });
}

export function loadApiConfig(): ApiConfig {
  try {
    const stored = sessionStorage.getItem("llwp-ppt-api-config");
    if (!stored) return defaultApiConfig;
    const parsed = JSON.parse(stored) as Partial<ApiConfig>;
    if ((parsed.configVersion || 0) < 2) parsed.imageCount = 0;
    if ((parsed.configVersion || 0) < 3) parsed.imageTextMode = "native";
    if ((parsed.configVersion || 0) < 4) {
      parsed.imageTextMode = "integrated";
      parsed.imageQuality = "high";
    }
    if ((parsed.configVersion || 0) < 5) {
      parsed.imageTimeoutSeconds = 600;
      parsed.imageMaxRetries = 1;
    }
    const legacy = parsed as Record<string, unknown>;
    ["provider", "baseUrl", "model", "apiKey", "imageBaseUrl", "imageApiKey", "imageModel"].forEach((key) => delete legacy[key]);
    return { ...defaultApiConfig, ...parsed, configVersion: 6 };
  } catch {
    return defaultApiConfig;
  }
}

export function maxAssetIndex(assets: GeneratedAsset[]) {
  return assets.reduce((max, asset) => Math.max(max, asset.index), 0);
}

export function compactTopic(value: string) {
  const line = value.replace(/\s+/g, " ").trim().split(/[。！？!?；;]/)[0] || "导入材料演示文稿";
  return line.length > 54 ? `${line.slice(0, 53)}…` : line;
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.round(value) : min));
}

export function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
