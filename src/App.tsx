import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  BrainCircuit,
  Check,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Code2,
  FileText,
  Image as ImageIcon,
  Layers3,
  LibraryBig,
  Loader2,
  MessageSquare,
  MonitorUp,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Settings2,
  Sparkles,
  Table2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import { parseAttachment, type ParsedAttachment } from "./lib/attachmentParser";
import { exportNotebookDeck } from "./lib/exportDeck";
import { buildLocalDeck } from "./lib/localPlanner";
import {
  generateAiDeck,
  generateAiHtmlDeck,
  patchAiHtmlDeck,
  testApiConnection,
  type ApiConfig,
  type AiStreamUpdate,
} from "./lib/apiClient";
import {
  styleProfiles,
  type GeneratedAsset,
  type NotebookDeckSpec,
  type NotebookSlideSpec,
} from "./types";
import { HtmlDeckWorkspace } from "./html-deck/HtmlDeckWorkspace";
import { notebookToHtmlDeck } from "./html-deck/fromNotebook";
import { exportStandaloneHtmlDeck } from "./html-deck/exportHtmlDeck";
import { exportHtmlDeckAsPptx } from "./html-deck/exportHtmlDeckPptx";
import { listHtmlDecks, saveHtmlDeck } from "./html-deck/persistence";
import { applyHtmlDeckPatches } from "./html-deck/patches";
import { htmlDeckSchema } from "./html-deck/schema";
import type { HtmlDeckSpec } from "./html-deck/types";
import { HomeScreen, type GenerationPreset } from "./components/HomeScreen";
import { ApiSettings, SlideCanvas, SlideEditor, WorkflowRow } from "./components/WorkspacePanels";
import {
  assetToApiImage,
  attachEditableTable,
  clamp,
  compactTopic,
  imageProgressDetail,
  inspectImage,
  loadApiConfig,
  maxAssetIndex,
  orderedGeneratedAssets,
  remapUploadedImageIndexes,
  runImageGenerationStage,
  sleep,
  toDeckSource,
  type GenerationSource,
  type PipelineCheckpoint,
} from "./app/pipeline";
import {
  htmlInitialSteps,
  initialSteps,
  shouldRunFrom,
  stepOrder,
  stepTitle,
  type StepId,
  type StepStatus,
  type WorkflowActivity,
  type WorkflowStep,
} from "./app/workflow";

type Mode = "local" | "ai" | "html";
type Screen = "home" | "workspace";
type SourceTab = "text" | "table" | "image";
type HtmlSidebarTab = "chat" | "context";

type LiveActivity = {
  phase: string;
  message: string;
  detail: string;
};

function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [prompt, setPrompt] = useState("");
  const [preset, setPreset] = useState<GenerationPreset>("api-visual");
  const [attachments, setAttachments] = useState<ParsedAttachment[]>([]);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const [homeMessage, setHomeMessage] = useState("");
  const [mode, setMode] = useState<Mode>("local");
  const [sourceTab, setSourceTab] = useState<SourceTab>("text");
  const [htmlSidebarTab, setHtmlSidebarTab] = useState<HtmlSidebarTab>("chat");
  const [htmlSidebarCollapsed, setHtmlSidebarCollapsed] = useState(false);
  const [topic, setTopic] = useState("新建演示文稿");
  const [audience, setAudience] = useState("");
  const [slideCount, setSlideCount] = useState(7);
  const [textInput, setTextInput] = useState("");
  const [tableInput, setTableInput] = useState("");
  const [imageBrief, setImageBrief] = useState("保留上传图片的主体身份；让核心文字与主视觉相互解释，形成完整页面构图。");
  const [styleId, setStyleId] = useState("blank");
  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [deck, setDeck] = useState<NotebookDeckSpec>(() => buildLocalDeck({
    topic: "新建演示文稿",
    audience: "通用受众",
    slideCount: 7,
    textInput: "",
    tableInput: "",
    imageBrief: "专业、克制，让文字与视觉相互配合。",
    styleId: "blank",
    assets: [],
  }));
  const [htmlDeck, setHtmlDeck] = useState<HtmlDeckSpec>(() => notebookToHtmlDeck(deck, []));
  const [steps, setSteps] = useState<WorkflowStep[]>(initialSteps);
  const [apiConfig, setApiConfig] = useState<ApiConfig>(loadApiConfig);
  const [apiSettingsOpen, setApiSettingsOpen] = useState(false);
  const [selectedSlide, setSelectedSlide] = useState(0);
  const [isRunning, setRunning] = useState(false);
  const [isExporting, setExporting] = useState(false);
  const [isHtmlExporting, setHtmlExporting] = useState(false);
  const [isHtmlAiEditing, setHtmlAiEditing] = useState(false);
  const [htmlPreviewPending, setHtmlPreviewPending] = useState(false);
  const [connection, setConnection] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [envKeyConfigured, setEnvKeyConfigured] = useState(false);
  const [apiCalls, setApiCalls] = useState(0);
  const [liveApiCalls, setLiveApiCalls] = useState(0);
  const [failedStep, setFailedStep] = useState<StepId | null>(null);
  const [status, setStatus] = useState("本地闭环可直接运行；开启 API 模式可完成五阶段增强。");
  const [activityEntries, setActivityEntries] = useState<WorkflowActivity[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pipelineCheckpointRef = useRef<PipelineCheckpoint | null>(null);
  const htmlPipelineCheckpointRef = useRef<PipelineCheckpoint | null>(null);
  const htmlPersistenceReadyRef = useRef(false);
  const streamUiRef = useRef({ lastAt: 0, message: "" });
  const activityIdRef = useRef(0);
  const timelineEndRef = useRef<HTMLDivElement>(null);

  const currentSlide = deck.slides[selectedSlide] || deck.slides[0];
  const currentStyle = styleProfiles.find((style) => style.id === styleId)
    || styleProfiles.find((style) => style.id === "product-calm")!;
  const uploadedAssets = useMemo(() => assets.filter((asset) => asset.kind === "upload"), [assets]);
  const generatedCount = assets.filter((asset) => asset.kind === "generated").length;

  useEffect(() => {
    sessionStorage.setItem("llwp-ppt-api-config", JSON.stringify(apiConfig));
  }, [apiConfig]);

  useEffect(() => {
    fetch("/api/health").then((response) => response.json()).then((data) => {
      setEnvKeyConfigured(Boolean(data.envKeyConfigured));
      const defaults = data.apiDefaults;
      if (defaults) {
        setApiConfig((current) => ({
          ...current,
          imageTimeoutSeconds: clamp(Number(defaults.imageTimeoutMs) / 1_000, 240, 900),
          imageMaxRetries: clamp(Number(defaults.imageMaxRetries), 0, 2),
        }));
      }
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    setSelectedSlide((index) => Math.min(index, Math.max(deck.slides.length - 1, 0)));
  }, [deck.slides.length]);

  useEffect(() => {
    void listHtmlDecks().then((saved) => {
      const latest = saved.sort((left, right) => String(right.savedAt || "").localeCompare(String(left.savedAt || "")))[0];
      const parsed = htmlDeckSchema.safeParse(latest);
      if (parsed.success) setHtmlDeck(parsed.data as HtmlDeckSpec);
    }).catch(() => undefined).finally(() => { htmlPersistenceReadyRef.current = true; });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!htmlPersistenceReadyRef.current) return;
      void saveHtmlDeck(htmlDeck).catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [htmlDeck]);

  useEffect(() => {
    if (mode !== "html" || htmlSidebarTab !== "chat") return;
    timelineEndRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activityEntries, htmlSidebarTab, mode, steps]);

  function recordActivity(stepId: StepId, activity: LiveActivity) {
    setActivityEntries((current) => {
      let lastIndex = -1;
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (current[index].stepId === stepId && current[index].status === "running") {
          lastIndex = index;
          break;
        }
      }
      if (lastIndex >= 0 && current[lastIndex].message === activity.message) {
        return current.map((entry, index) => index === lastIndex ? { ...entry, detail: activity.detail } : entry);
      }
      const completed = current.map((entry) => entry.stepId === stepId && entry.status === "running" ? { ...entry, status: "done" as const } : entry);
      return [...completed, {
        id: `activity-${++activityIdRef.current}`,
        stepId,
        message: activity.message,
        detail: activity.detail,
        status: "running",
      }];
    });
  }

  function updateStep(id: StepId, statusValue: StepStatus, detail?: string) {
    setSteps((current) => current.map((step) => step.id === id ? { ...step, status: statusValue, detail: detail || step.detail } : step));
    if (statusValue !== "running") {
      setActivityEntries((current) => current.map((entry) => entry.stepId === id && entry.status === "running" ? { ...entry, status: "done" } : entry));
    }
  }

  function createStreamReporter(stepId: StepId, fallbackMessage: string) {
    streamUiRef.current = { lastAt: 0, message: fallbackMessage };
    recordActivity(stepId, { phase: stepId, message: fallbackMessage, detail: "正在等待模型返回首批内容" });
    return (update: AiStreamUpdate) => {
      if (update.type === "phase" && update.message) streamUiRef.current.message = update.message;
      if (update.type === "request") setLiveApiCalls((value) => value + 1);
      const now = Date.now();
      if (update.type === "delta" && now - streamUiRef.current.lastAt < 120) return;
      streamUiRef.current.lastAt = now;
      const message = streamUiRef.current.message || fallbackMessage;
      const detail = update.totalChars
        ? `已流式接收 ${update.totalChars.toLocaleString()} 字符`
        : update.type === "request" ? update.message || "模型请求已发送"
          : update.type === "start" ? "流式连接已建立" : "正在处理结构化内容";
      recordActivity(stepId, { phase: update.phase || stepId, message, detail });
      updateStep(stepId, "running", `${message} · ${detail}`);
      setStatus(`${message}，${detail}…`);
    };
  }

  function completeApiCalls(count: number) {
    setApiCalls((value) => value + count);
    setLiveApiCalls(0);
  }

  async function withElapsedActivity<T>(phase: StepId, message: string, task: () => Promise<T>) {
    const startedAt = Date.now();
    const tick = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
      recordActivity(phase, { phase, message, detail: seconds ? `已等待 ${seconds} 秒` : "请求已发送" });
    };
    tick();
    const timer = window.setInterval(tick, 1_000);
    try { return await task(); }
    finally { window.clearInterval(timer); }
  }

  function resetSteps(template: WorkflowStep[] = initialSteps) {
    setSteps(template.map((step) => ({ ...step })));
    setActivityEntries([]);
  }

  function runLocal(source: GenerationSource = { topic, audience, slideCount, textInput, tableInput, imageBrief, styleId, assets }) {
    if (!source.audience.trim()) {
      const detail = "请先填写目标受众，例如：董事会、投资人、客户或内部团队。";
      setHomeMessage(detail);
      setStatus(detail);
      return;
    }
    pipelineCheckpointRef.current = null;
    setFailedStep(null);
    const next = buildLocalDeck(source);
    const sourceUploads = source.assets.filter((asset) => asset.kind === "upload");
    setDeck(next);
    setAssets(source.assets);
    setSelectedSlide(0);
    setApiCalls(0);
    setLiveApiCalls(0);
    resetSteps();
    updateStep("logic", "done", "本地规则已提取观点并生成叙事骨架");
    updateStep("image", "skipped", sourceUploads.length ? "使用用户上传图片，不调用外部生图" : "本地模式未调用图像模型");
    updateStep("decompose", "skipped", "本地模式保留原图，不做视觉拆解");
    updateStep("assemble", "done", "已组装原生标题、正文、表格与上传图片");
    updateStep("export", "idle", "点击右上角即可导出可编辑 PPTX");
    setStatus("本地 DeckSpec 已更新。内容与表格可以继续编辑后导出。");
  }

  async function runAiPipeline(
    source: GenerationSource = { topic, audience, slideCount, textInput, tableInput, imageBrief, styleId, assets },
    config: ApiConfig = apiConfig,
    resume = false,
  ) {
    if (isRunning) return;
    const savedCheckpoint = resume ? pipelineCheckpointRef.current : null;
    source = savedCheckpoint?.source || source;
    config = savedCheckpoint?.config || config;
    if (!source.audience.trim()) {
      const detail = "请先填写目标受众，例如：董事会、投资人、客户或内部团队。";
      setHomeMessage(detail);
      setStatus(detail);
      return;
    }
    const sourceUploads = savedCheckpoint?.sourceUploads || source.assets.filter((asset) => asset.kind === "upload");
    const sourceStyle = styleProfiles.find((style) => style.id === source.styleId)
      || styleProfiles.find((style) => style.id === "product-calm")!;
    setRunning(true);
    setFailedStep(null);
    if (!resume) {
      setApiCalls(0);
      setLiveApiCalls(0);
      resetSteps();
      setAssets(sourceUploads);
    }
    let checkpoint: PipelineCheckpoint = savedCheckpoint || {
      source,
      config,
      sourceImages: [],
      sourceUploads,
      assets: sourceUploads,
      generatedBySlide: {},
      requestedImageCount: 0,
      resumeFrom: "logic",
    };
    const startFrom = checkpoint.resumeFrom;
    let activeStep: StepId = startFrom;
    let nextDeck = checkpoint.deck;
    let nextAssets = checkpoint.assets;
    let sourceImages = checkpoint.sourceImages;
    if (resume) {
      updateStep(startFrom, "running", `正在从“${stepTitle(startFrom)}”继续，前序结果已保留`);
      setStatus(`正在从第 ${String(stepOrder.indexOf(startFrom) + 1).padStart(2, "0")} 步继续，不会重复已完成的 API 调用…`);
    }
    try {
      if (shouldRunFrom(startFrom, "logic")) {
        activeStep = "logic";
        setStatus("正在读取文字、表格和图片，并建立演示论证链…");
        updateStep("logic", "running", "模型正在区分结论、证据、缺口与行动");
        sourceImages = await Promise.all(sourceUploads.slice(0, 3).map(assetToApiImage));
        const response = await generateAiDeck(config, toDeckSource(source, sourceImages), createStreamReporter("logic", "正在建立演示叙事"));
        nextDeck = attachEditableTable(remapUploadedImageIndexes(response.deck, sourceUploads), source.tableInput);
        nextAssets = sourceUploads;
        checkpoint = {
          ...checkpoint,
          sourceImages,
          deck: nextDeck,
          assets: nextAssets,
          generatedBySlide: {},
          resumeFrom: "image",
        };
        pipelineCheckpointRef.current = checkpoint;
        setDeck(nextDeck);
        setAssets(nextAssets);
        setSelectedSlide(0);
        completeApiCalls(response.meta.apiCalls);
        updateStep("logic", "done", response.meta.refinementApplied
          ? `双轮策划完成：${nextDeck.slides.length} 页因果叙事，${nextDeck.story.evidenceGaps.length} 个证据缺口`
          : `已形成 ${nextDeck.slides.length} 页叙事，发现 ${nextDeck.story.evidenceGaps.length} 个证据缺口`);
      }
      if (!nextDeck) throw new Error("没有可继续使用的演示结构，请从内容策划重新开始。");
      if (shouldRunFrom(startFrom, "image")) {
        activeStep = "image";
        if (config.imageEnabled) {
          const requestedImageCount = config.imageCount === 0 ? nextDeck.slides.length : Math.min(config.imageCount, nextDeck.slides.length);
          checkpoint.requestedImageCount = requestedImageCount;
          updateStep("image", "running", imageProgressDetail(checkpoint.generatedBySlide, requestedImageCount));
          const imageResult = await runImageGenerationStage({
            deck: nextDeck,
            config,
            sourceUploads,
            sourceImages,
            styleId: source.styleId,
            generatedBySlide: checkpoint.generatedBySlide,
            requestedImageCount,
            textMode: config.imageTextMode,
            assetIdPrefix: "generated",
            filenamePrefix: "image2-slide",
            summary: (slideIndex) => config.imageTextMode === "integrated"
              ? `Image 2 为第 ${slideIndex + 1} 页生成的整页图文画面`
              : `Image 2 为第 ${slideIndex + 1} 页生成的独立主视觉资产`,
            activityMessage: (slideIndex, total) => `正在生成第 ${slideIndex + 1}/${total} 页视觉`,
            onJobStart: (slideIndex, total, completed) => {
              setStatus(source.styleId === "blank"
                ? `正在生成第 ${slideIndex + 1}/${total} 页；已完成 ${completed} 页，成功结果会立即保存…`
                : `正在用 ${sourceStyle.name} 生成第 ${slideIndex + 1}/${total} 页；已完成 ${completed} 页…`);
              updateStep("image", "running", `正在生成第 ${slideIndex + 1}/${total} 页；已保存 ${completed}/${total} 页`);
            },
            runWithActivity: (message, task) => withElapsedActivity("image", message, task),
            requestError: (error, slideIndex, total) => {
              const message = error instanceof Error ? error.message : "图片服务请求失败";
              return new Error(`第 ${slideIndex + 1}/${total} 页生图失败：${message}`);
            },
            onJobComplete: (progress) => {
              nextDeck = progress.deck;
              nextAssets = progress.assets;
              checkpoint = {
                ...checkpoint,
                deck: nextDeck,
                assets: nextAssets,
                resumeFrom: "image",
              };
              pipelineCheckpointRef.current = checkpoint;
              setAssets(nextAssets);
              setDeck(nextDeck);
              setApiCalls((value) => value + progress.apiCalls);
              updateStep("image", "running", imageProgressDetail(checkpoint.generatedBySlide, requestedImageCount));
            },
          });
          nextDeck = imageResult.deck;
          nextAssets = imageResult.assets;
          const generatedAssets = orderedGeneratedAssets(checkpoint.generatedBySlide);
          if (generatedAssets.length < requestedImageCount) {
            throw new Error(`图片只完成 ${generatedAssets.length}/${requestedImageCount} 页`);
          }
          updateStep("image", "done", config.imageTextMode === "integrated"
            ? `按要求生成 ${generatedAssets.length}/${requestedImageCount} 张连续整页图文画面`
            : `按要求生成 ${generatedAssets.length}/${requestedImageCount} 张独立主视觉资产`);
        } else {
          updateStep("image", "skipped", "图片生成已关闭，保留用户上传图片");
        }
        checkpoint = { ...checkpoint, deck: nextDeck, assets: nextAssets, resumeFrom: "decompose" };
        pipelineCheckpointRef.current = checkpoint;
      }

      if (shouldRunFrom(startFrom, "decompose")) {
        activeStep = "decompose";
        if (!config.imageEnabled) {
          updateStep("decompose", "skipped", "没有生成图需要校验");
        } else if (config.imageTextMode === "integrated") {
          updateStep("decompose", "done", `已确认 ${orderedGeneratedAssets(checkpoint.generatedBySlide).length} 张成片数量一致，并统一整理为 16:9 画布`);
        } else {
          updateStep("decompose", "done", "原生分层模式已保留独立图片与文字对象");
        }
        checkpoint = { ...checkpoint, resumeFrom: "assemble" };
        pipelineCheckpointRef.current = checkpoint;
      }

      if (shouldRunFrom(startFrom, "assemble")) {
        activeStep = "assemble";
        updateStep("assemble", "running", config.imageTextMode === "integrated" ? "正在按原始构图装入整页融合成片" : "正在映射原生文字、表格、图片和讲稿备注");
        setStatus(config.imageEnabled && config.imageTextMode === "integrated" ? "正在组装图文页面并保存可追溯内容源…" : "正在组装可编辑页面对象…");
        await sleep(240);
        setDeck(nextDeck);
        updateStep("assemble", "done", config.imageEnabled && config.imageTextMode === "integrated"
          ? `${nextDeck.slides.length} 页已组装，完整保留 Image 2 的图文构图`
          : `${nextDeck.slides.length} 页已组装，文字和表格保持原生可编辑`);
        checkpoint = { ...checkpoint, deck: nextDeck, assets: nextAssets, resumeFrom: "export" };
        pipelineCheckpointRef.current = checkpoint;
      }

      if (shouldRunFrom(startFrom, "export")) {
        activeStep = "export";
        updateStep("export", "running", "正在写入 PowerPoint 文件");
        setStatus(config.imageEnabled && config.imageTextMode === "integrated"
          ? "正在生成 PPTX，并写入图文页面、内容源与讲稿备注…"
          : "正在生成可编辑 PPTX，完成后浏览器会保存文件…");
        await exportNotebookDeck(nextDeck, nextAssets);
        updateStep("export", "done", "PPTX 已生成并保存到下载目录");
      }
      pipelineCheckpointRef.current = null;
      setFailedStep(null);
      setStatus(config.imageEnabled && config.imageTextMode === "integrated"
        ? "五阶段流程完成。融合页修改内容源后需要重新生成画面。"
        : "五阶段流程完成。你可以继续修改右侧内容并再次导出。");
    } catch (error) {
      const message = error instanceof Error ? error.message : "流程执行失败";
      checkpoint = { ...checkpoint, deck: nextDeck, assets: nextAssets, resumeFrom: activeStep };
      pipelineCheckpointRef.current = checkpoint;
      setFailedStep(activeStep);
      updateStep(activeStep, "error", `${message}；前序成功结果已保存`);
      setStatus(`${message}。可以从“${stepTitle(activeStep)}”继续，不会重跑已经完成的环节。`);
    } finally {
      setRunning(false);
    }
  }

  async function runHtmlPipeline(
    source: GenerationSource = { topic, audience, slideCount, textInput, tableInput, imageBrief, styleId, assets },
    config: ApiConfig = { ...apiConfig, imageEnabled: true, imageTextMode: "native", imageQuality: "high" },
    resume = false,
  ) {
    if (isRunning) return;
    const savedCheckpoint = resume ? htmlPipelineCheckpointRef.current : null;
    source = savedCheckpoint?.source || source;
    config = savedCheckpoint?.config || config;
    if (!source.audience.trim()) {
      const detail = "请先填写目标受众，例如：董事会、投资人、客户或内部团队。";
      setHomeMessage(detail);
      setStatus(detail);
      return;
    }
    const sourceUploads = savedCheckpoint?.sourceUploads || source.assets.filter((asset) => asset.kind === "upload");
    const sourceStyle = styleProfiles.find((style) => style.id === source.styleId)
      || styleProfiles.find((style) => style.id === "product-calm")!;
    let checkpoint: PipelineCheckpoint = savedCheckpoint || {
      source,
      config,
      sourceImages: [],
      sourceUploads,
      assets: sourceUploads,
      generatedBySlide: {},
      requestedImageCount: 0,
      resumeFrom: "logic",
    };
    const startFrom = checkpoint.resumeFrom;
    let activeStep: StepId = startFrom;
    let nextAssets = checkpoint.assets;
    let nextDeck = checkpoint.deck;
    let sourceImages = checkpoint.sourceImages;
    let previewHtmlDeck = htmlDeck;

    setMode("html");
    setRunning(true);
    setFailedStep(null);
    if (!resume) {
      setHtmlPreviewPending(true);
      setApiCalls(0);
      setLiveApiCalls(0);
      resetSteps(htmlInitialSteps);
      setAssets(sourceUploads);
    } else {
      updateStep(startFrom, "running", `正在从“${stepTitle(startFrom)}”继续，前序结果已保留`);
      setStatus(`正在继续 HTML 生成，不会重复已完成的 API 调用…`);
    }
    try {
      if (shouldRunFrom(startFrom, "logic")) {
        activeStep = "logic";
        updateStep("logic", "running", "正在建立适合交互表达的跨页论证结构");
        setStatus("正在读取材料，并为 HTML 演示建立内容结构…");
        sourceImages = await Promise.all(sourceUploads.slice(0, 3).map(assetToApiImage));
        const response = await generateAiDeck(config, toDeckSource(source, sourceImages), createStreamReporter("logic", "正在建立交互演示叙事"));
        nextDeck = attachEditableTable(remapUploadedImageIndexes(response.deck, sourceUploads), source.tableInput);
        previewHtmlDeck = {
          ...notebookToHtmlDeck(nextDeck, sourceUploads),
          id: previewHtmlDeck.id,
          revision: previewHtmlDeck.revision + 1,
        };
        checkpoint = { ...checkpoint, sourceImages, deck: nextDeck, assets: sourceUploads, generatedBySlide: {}, resumeFrom: "image" };
        htmlPipelineCheckpointRef.current = checkpoint;
        setDeck(nextDeck);
        setHtmlDeck(previewHtmlDeck);
        setHtmlPreviewPending(false);
        completeApiCalls(response.meta.apiCalls);
        updateStep("logic", "done", `完成 ${nextDeck.slides.length} 页叙事与交互内容基础`);
      }
      if (!nextDeck) throw new Error("没有可继续使用的演示结构，请从内容策划重新开始。");

      if (shouldRunFrom(startFrom, "image")) {
        activeStep = "image";
        if (config.imageEnabled) {
          const requestedImageCount = config.imageCount === 0 ? nextDeck.slides.length : Math.min(config.imageCount, nextDeck.slides.length);
          checkpoint.requestedImageCount = requestedImageCount;
          updateStep("image", "running", imageProgressDetail(checkpoint.generatedBySlide, requestedImageCount));
          const imageResult = await runImageGenerationStage({
            deck: nextDeck,
            config,
            requestConfig: { ...config, imageTextMode: "native" },
            sourceUploads,
            sourceImages,
            styleId: source.styleId,
            generatedBySlide: checkpoint.generatedBySlide,
            requestedImageCount,
            textMode: "native",
            assetIdPrefix: "html-visual",
            filenamePrefix: "html-slide",
            summary: (slideIndex) => `HTML 演示第 ${slideIndex + 1} 页的独立主视觉`,
            activityMessage: (slideIndex, total) => `正在生成第 ${slideIndex + 1}/${total} 张 HTML 主视觉`,
            onJobStart: (slideIndex, total, completed) => {
              setStatus(`正在用 ${sourceStyle.name} 生成第 ${slideIndex + 1}/${total} 张 HTML 主视觉；已保存 ${completed} 张…`);
            },
            runWithActivity: (message, task) => withElapsedActivity("image", message, task),
            missingImageError: (slideIndex) => new Error(`第 ${slideIndex + 1} 页没有返回完整视觉素材`),
            onJobComplete: (progress) => {
              nextDeck = progress.deck;
              nextAssets = progress.assets;
              previewHtmlDeck = {
                ...notebookToHtmlDeck(nextDeck, nextAssets),
                id: previewHtmlDeck.id,
                revision: previewHtmlDeck.revision + 1,
              };
              checkpoint = { ...checkpoint, deck: nextDeck, assets: nextAssets, resumeFrom: "image" };
              htmlPipelineCheckpointRef.current = checkpoint;
              setDeck(nextDeck);
              setAssets(nextAssets);
              setHtmlDeck(previewHtmlDeck);
              setApiCalls((value) => value + progress.apiCalls);
              updateStep("image", "running", imageProgressDetail(checkpoint.generatedBySlide, requestedImageCount));
            },
          });
          nextDeck = imageResult.deck;
          nextAssets = imageResult.assets;
          updateStep("image", "done", `已生成 ${Object.keys(checkpoint.generatedBySlide).length} 张可独立编辑位置的主视觉`);
        } else {
          updateStep("image", "skipped", "图片生成关闭，使用原生图形和用户素材");
        }
        checkpoint = { ...checkpoint, deck: nextDeck, assets: nextAssets, resumeFrom: "decompose" };
        htmlPipelineCheckpointRef.current = checkpoint;
      }

      if (shouldRunFrom(startFrom, "decompose")) {
        activeStep = "decompose";
        updateStep("decompose", "running", "正在建立 HTML 对象、图层、图表和交互关系");
        setStatus("正在把演示内容编排为可编辑 HtmlDeckSpec…");
        const htmlDraft = {
          ...notebookToHtmlDeck(nextDeck, nextAssets),
          id: previewHtmlDeck.id,
          revision: previewHtmlDeck.revision + 1,
        };
        setHtmlDeck(htmlDraft);
        const htmlResponse = await generateAiHtmlDeck(
          config,
          nextDeck,
          htmlDraft,
          source.styleId,
          createStreamReporter("decompose", "正在优化 HTML 场景"),
        );
        const nextHtmlDeck = htmlResponse.deck;
        completeApiCalls(htmlResponse.meta.apiCalls);
        setHtmlDeck(nextHtmlDeck);
        updateStep("decompose", "done", htmlResponse.meta.designApplied
          ? `${nextHtmlDeck.slides.length} 页经 AI 设计为 ${nextHtmlDeck.slides.reduce((sum, slide) => sum + slide.nodes.length, 0)} 个可编辑对象`
          : `${nextHtmlDeck.slides.length} 页使用安全编排器生成；AI 设计结果未通过 Schema 校验`);
        checkpoint = { ...checkpoint, resumeFrom: "assemble" };
        htmlPipelineCheckpointRef.current = checkpoint;
      }

      if (shouldRunFrom(startFrom, "assemble")) {
        activeStep = "assemble";
        updateStep("assemble", "running", "正在装载安全沙箱、翻页、图表和编辑桥接");
        await sleep(220);
        updateStep("assemble", "done", "交互编辑器已就绪：属性、评论、微调、手绘和撤销重做可用");
      }

      activeStep = "export";
      updateStep("export", "done", "可导出离线 HTML；静态 PPTX 作为兼容交付");
      setStatus("交互式 HTML 演示已生成。现在可以选择元素编辑、添加评论、微调参数或手绘标注。");
      htmlPipelineCheckpointRef.current = null;
      setFailedStep(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "HTML 演示生成失败";
      checkpoint = { ...checkpoint, deck: nextDeck, assets: nextAssets, resumeFrom: activeStep };
      htmlPipelineCheckpointRef.current = checkpoint;
      setFailedStep(activeStep);
      updateStep(activeStep, "error", `${message}；前序成功结果已保存`);
      setStatus(`${message}。可以从“${stepTitle(activeStep)}”继续，不会重跑已完成的内容和图片。`);
    } finally {
      setRunning(false);
    }
  }

  function resumeHtmlPipeline() {
    const checkpoint = htmlPipelineCheckpointRef.current;
    if (!checkpoint || isRunning) return;
    void runHtmlPipeline(checkpoint.source, checkpoint.config, true);
  }

  function resumeAiPipeline() {
    const checkpoint = pipelineCheckpointRef.current;
    if (!checkpoint || isRunning) return;
    void runAiPipeline(checkpoint.source, checkpoint.config, true);
  }

  function restartAiPipeline() {
    if (isRunning) return;
    pipelineCheckpointRef.current = null;
    setFailedStep(null);
    void runAiPipeline();
  }

  async function exportCurrentDeck() {
    if (isExporting) return;
    setExporting(true);
    try {
      await exportNotebookDeck(deck, assets);
      updateStep("export", "done", "当前版本已重新导出");
      setStatus("可编辑 PPTX 已导出。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "导出失败。");
    } finally {
      setExporting(false);
    }
  }

  async function exportCurrentHtmlDeck() {
    if (isHtmlExporting) return;
    setHtmlExporting(true);
    try {
      await exportStandaloneHtmlDeck(htmlDeck);
      updateStep("export", "done", "离线交互 HTML 已保存到下载目录");
      setStatus("交互 HTML 已导出，动画、图表和点击交互可离线运行。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "HTML 导出失败。");
    } finally {
      setHtmlExporting(false);
    }
  }

  async function exportCurrentHtmlPptx() {
    if (isHtmlExporting) return;
    setHtmlExporting(true);
    try {
      await exportHtmlDeckAsPptx(htmlDeck);
      setStatus("静态 PPTX 已导出。文字、图形和图表可编辑，Web 交互不会保留。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "静态 PPTX 导出失败。");
    } finally {
      setHtmlExporting(false);
    }
  }

  async function requestHtmlAiEdit(instruction: string, slideId: string, nodeId?: string) {
    if (isHtmlAiEditing) return;
    setHtmlAiEditing(true);
    setStatus("正在应用局部 AI 修改…");
    try {
      const response = await patchAiHtmlDeck(
        apiConfig,
        htmlDeck,
        instruction,
        slideId,
        nodeId,
        createStreamReporter("decompose", "正在生成局部修改"),
      );
      completeApiCalls(response.meta.apiCalls);
      const result = applyHtmlDeckPatches(htmlDeck, response.patches);
      if (!result.applied) throw new Error("模型没有返回可安全应用的修改。");
      setHtmlDeck(result.deck);
      setStatus(response.summary || `已应用 ${result.applied} 项局部修改。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "局部 AI 修改失败，原稿未改变。");
      throw error;
    } finally {
      setHtmlAiEditing(false);
    }
  }

  async function handleFiles(files: FileList | File[]) {
    const accepted = Array.from(files).filter((file) => file.type.startsWith("image/")).slice(0, 6 - uploadedAssets.length);
    if (!accepted.length) return;
    const startIndex = maxAssetIndex(assets) + 1;
    const additions = await Promise.all(accepted.map((file, index) => inspectImage(file, startIndex + index, imageBrief)));
    setAssets((current) => [...current.filter((asset) => asset.kind !== "generated" && asset.kind !== "crop"), ...additions]);
    setStatus(`已加入 ${additions.length} 张内容参考图。API 模式会把它们与风格引导图分开使用。`);
  }

  async function handleAttachmentFiles(files: FileList | File[]) {
    const incoming = Array.from(files).slice(0, Math.max(0, 8 - attachments.length));
    if (!incoming.length) return;
    setAttachmentMenuOpen(false);
    setHomeMessage("正在读取附件…");
    const parsed: ParsedAttachment[] = [];
    const imageAssets: GeneratedAsset[] = [];
    let nextIndex = maxAssetIndex(assets) + 1;
    let remainingImages = Math.max(0, 6 - uploadedAssets.length);

    for (const file of incoming) {
      try {
        const attachment = await parseAttachment(file, { onProgress: setHomeMessage });
        const acceptedImages = attachment.imageFiles.slice(0, remainingImages);
        const attachmentAssets: GeneratedAsset[] = [];
        for (const imageFile of acceptedImages) {
          const asset = await inspectImage(imageFile, nextIndex, imageBrief);
          attachmentAssets.push(asset);
          imageAssets.push(asset);
          nextIndex += 1;
          remainingImages -= 1;
        }
        const blocks = attachment.blocks.map((block) => block.type === "image" && block.imageFileIndex !== undefined
          ? { ...block, assetId: attachmentAssets[block.imageFileIndex]?.id }
          : block);
        parsed.push({ ...attachment, blocks, assetIds: attachmentAssets.map((asset) => asset.id) });
      } catch (error) {
        setHomeMessage(error instanceof Error ? error.message : `无法读取 ${file.name}`);
      }
    }

    if (parsed.length) {
      setAttachments((current) => [...current, ...parsed]);
      setAssets((current) => [
        ...current.filter((asset) => asset.kind === "upload"),
        ...imageAssets,
      ]);
      setHomeMessage(`已读取 ${parsed.length} 个附件`);
    }
  }

  function removeHomeAttachment(id: string) {
    const target = attachments.find((attachment) => attachment.id === id);
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
    if (target?.assetIds.length) {
      const ids = new Set(target.assetIds);
      setAssets((current) => current.filter((asset) => !ids.has(asset.id)));
    }
    setHomeMessage("");
  }

  async function startFromComposer() {
    const attachmentTables = attachments.map((attachment) => attachment.tableText).filter(Boolean).join("\n");
    const combinedTable = attachmentTables;
    const sourceBlocks = attachments.flatMap((attachment) => attachment.blocks);
    if (!prompt.trim() && !sourceBlocks.length && !combinedTable && !uploadedAssets.length) {
      setHomeMessage("请描述演示主题，或先添加一份材料。");
      return;
    }
    if (!audience.trim()) {
      setHomeMessage("请指明目标受众，例如：董事会、投资人、客户或内部团队。");
      return;
    }

    const nextTopic = compactTopic(prompt || attachments[0]?.name || "导入材料演示文稿");
    const source: GenerationSource = {
      topic: nextTopic,
      audience,
      slideCount,
      textInput: prompt.trim() || `请根据已上传材料制作一份关于“${nextTopic}”的演示文稿。`,
      tableInput: combinedTable,
      imageBrief,
      styleId,
      assets: assets.filter((asset) => asset.kind === "upload"),
      sourceBlocks,
    };
    setTopic(source.topic);
    setTextInput(source.textInput);
    setTableInput(source.tableInput);
    setScreen("workspace");

    if (preset === "local") {
      setMode("local");
      runLocal(source);
      return;
    }

    if (preset === "html-interactive") {
      const nextConfig: ApiConfig = {
        ...apiConfig,
        imageEnabled: true,
        imageTextMode: "native",
        imageQuality: "high",
      };
      setMode("html");
      setApiConfig(nextConfig);
      await runHtmlPipeline(source, nextConfig);
      return;
    }

    const nextConfig: ApiConfig = {
      ...apiConfig,
      imageEnabled: preset === "api-visual",
      imageTextMode: preset === "api-visual" ? "integrated" : apiConfig.imageTextMode,
      imageQuality: preset === "api-visual" ? "high" : apiConfig.imageQuality,
    };
    setMode("ai");
    setApiConfig(nextConfig);
    await runAiPipeline(source, nextConfig);
  }

  function removeAsset(id: string) {
    setAssets((current) => current.filter((asset) => asset.id !== id && asset.parentId !== id));
  }

  function updateSlide(patch: Partial<NotebookSlideSpec>) {
    setDeck((current) => ({
      ...current,
      slides: current.slides.map((slide, index) => index === selectedSlide ? { ...slide, ...patch } : slide),
    }));
  }

  async function testConnection() {
    setConnection("testing");
    try {
      const result = await testApiConnection(apiConfig);
      setConnection("success");
      setStatus(`连接成功：${result.provider} · ${result.model} · ${result.latencyMs} ms`);
    } catch (error) {
      setConnection("error");
      setStatus(error instanceof Error ? error.message : "连接失败。");
    }
  }

  if (screen === "home") {
    return (
      <HomeScreen
        prompt={prompt}
        onPromptChange={setPrompt}
        preset={preset}
        onPresetChange={(value) => {
          setPreset(value);
          setPresetMenuOpen(false);
        }}
        presetMenuOpen={presetMenuOpen}
        onTogglePreset={() => setPresetMenuOpen((value) => !value)}
        attachmentMenuOpen={attachmentMenuOpen}
        onToggleAttachments={() => setAttachmentMenuOpen((value) => !value)}
        attachments={attachments}
        onFiles={handleAttachmentFiles}
        onRemoveAttachment={removeHomeAttachment}
        audience={audience}
        onAudienceChange={(value) => {
          setAudience(value);
          if (value.trim()) setHomeMessage("");
        }}
        styleId={styleId}
        onStyleChange={setStyleId}
        slideCount={slideCount}
        onSlideCountChange={setSlideCount}
        envKeyConfigured={envKeyConfigured}
        message={homeMessage}
        running={isRunning}
        onSubmit={startFromComposer}
        onOpenWorkspace={() => setScreen("workspace")}
      />
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand-lockup brand-button" onClick={() => setScreen("home")} title="返回首页">
          <span className="brand-mark"><Layers3 size={16} /></span>
          <div><strong>LLWP PPTMAKER</strong><span>{mode === "html" ? htmlPreviewPending ? topic : htmlDeck.title : deck.title}</span></div>
        </button>
        <div className="topbar-actions">
          <div className="mode-switch" aria-label="生成模式">
            <button className={mode === "local" ? "active" : ""} onClick={() => { setMode("local"); resetSteps(initialSteps); }}><MonitorUp size={14} />本地</button>
            <button className={mode === "ai" ? "active" : ""} onClick={() => { setMode("ai"); resetSteps(initialSteps); }}><Cloud size={14} />API</button>
            <button className={mode === "html" ? "active" : ""} onClick={() => { setMode("html"); resetSteps(htmlInitialSteps); }}><Code2 size={14} />交互网页</button>
          </div>
          <button className="icon-button" title="API 设置" aria-label="API 设置" onClick={() => setApiSettingsOpen((value) => !value)}><Settings2 size={17} /></button>
          <button className="secondary-button export-button" onClick={mode === "html" ? exportCurrentHtmlDeck : exportCurrentDeck} disabled={mode === "html" ? isHtmlExporting || htmlPreviewPending : isExporting}>
            {(mode === "html" ? isHtmlExporting : isExporting) ? <Loader2 className="spin" size={15} /> : <ArrowDownToLine size={15} />}{mode === "html" ? "导出 HTML" : "导出 PPTX"}
          </button>
        </div>
      </header>

      <div className={`workspace ${mode === "html" ? `html-design-workspace ${htmlSidebarCollapsed ? "sidebar-collapsed" : ""}` : ""}`}>
        <div className={mode === "html" ? "html-sidebar-shell" : "workspace-columns"}>
          {mode === "html" && (
            <div className="html-sidebar-header">
              <div className="html-sidebar-tabs" role="tablist" aria-label="交互演示侧栏">
                <button className={htmlSidebarTab === "chat" ? "active" : ""} onClick={() => setHtmlSidebarTab("chat")}><MessageSquare size={14} />Chat</button>
                <button className={htmlSidebarTab === "context" ? "active" : ""} onClick={() => setHtmlSidebarTab("context")}><LibraryBig size={14} />Context</button>
              </div>
              <button className="html-sidebar-collapse" onClick={() => setHtmlSidebarCollapsed(true)} title="收起侧栏" aria-label="收起侧栏"><PanelLeftClose size={16} /></button>
            </div>
          )}

        <aside className="source-rail" hidden={mode === "html" && htmlSidebarTab !== "context"}>
          <div className="rail-heading">
            <div><span className="eyebrow">SOURCE</span><h1>准备素材</h1></div>
            <span className="source-count">{textInput.length + tableInput.length} 字</span>
          </div>

          <label className="field-label">演示主题</label>
          <input className="text-input title-input" value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="这份 PPT 要说明什么？" />
          <div className="inline-fields">
            <label><span>目标受众（必填）</span><input value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="例如：投资人" /></label>
            <label><span>精确页数</span><input type="number" min={1} max={50} value={slideCount} onChange={(event) => setSlideCount(clamp(Number(event.target.value), 1, 50))} /></label>
          </div>

          <div className="source-tabs" role="tablist">
            <button className={sourceTab === "text" ? "active" : ""} onClick={() => setSourceTab("text")}><FileText size={14} />文字</button>
            <button className={sourceTab === "table" ? "active" : ""} onClick={() => setSourceTab("table")}><Table2 size={14} />表格</button>
            <button className={sourceTab === "image" ? "active" : ""} onClick={() => setSourceTab("image")}><ImageIcon size={14} />图片 <span>{uploadedAssets.length || ""}</span></button>
          </div>

          {sourceTab === "text" && (
            <div className="source-editor">
              <textarea value={textInput} onChange={(event) => setTextInput(event.target.value)} placeholder="粘贴长文、会议纪要、提纲或零散观点…" />
              <span className="editor-meta">将识别主张、证据、假设和行动</span>
            </div>
          )}
          {sourceTab === "table" && (
            <div className="source-editor">
              <textarea value={tableInput} onChange={(event) => setTableInput(event.target.value)} placeholder="粘贴 CSV、TSV 或 Markdown 表格…" />
              <span className="editor-meta">导出时保留为原生 PowerPoint 表格</span>
            </div>
          )}
          {sourceTab === "image" && (
            <div className="image-source-panel">
              <button className="dropzone" onClick={() => fileInputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void handleFiles(event.dataTransfer.files); }}>
                <Upload size={18} /><strong>加入内容参考图</strong><span>PNG、JPG、WebP · 最多 6 张</span>
              </button>
              <input ref={fileInputRef} hidden type="file" accept="image/*" multiple onChange={(event) => event.target.files && void handleFiles(event.target.files)} />
              <div className="asset-grid">
                {uploadedAssets.map((asset) => (
                  <figure key={asset.id}><img src={asset.url} alt={asset.filename} /><button title="移除图片" onClick={() => removeAsset(asset.id)}><X size={13} /></button><figcaption>{asset.filename}</figcaption></figure>
                ))}
              </div>
              <textarea className="brief-input" value={imageBrief} onChange={(event) => setImageBrief(event.target.value)} placeholder="说明图片中的主体和使用要求…" />
            </div>
          )}

          <div className="style-section">
            <div className="section-line"><div><span className="eyebrow">STYLE MEMORY</span><h2>风格知识库</h2></div><span>{currentStyle.name}</span></div>
            <div className="style-list">
              {styleProfiles.map((style) => (
                <button key={style.id} className={`style-option ${styleId === style.id ? "active" : ""}`} onClick={() => setStyleId(style.id)}>
                  {style.image
                    ? <img src={style.image} alt={`${style.name}风格引导图`} />
                    : <b className="blank-style-swatch" aria-hidden="true"><i /><i /><i /></b>}
                  <span><strong>{style.name}</strong><small>{style.description}</small></span>
                  {styleId === style.id && <Check size={15} />}
                </button>
              ))}
            </div>
          </div>

          {apiSettingsOpen && (
            <ApiSettings
              config={apiConfig}
              onChange={setApiConfig}
              envKeyConfigured={envKeyConfigured}
              connection={connection}
              onTest={testConnection}
            />
          )}
        </aside>

        <section className="agent-column" hidden={mode === "html" && htmlSidebarTab !== "chat"}>
          <div className="agent-header">
            <span className="agent-orbit"><Sparkles size={16} /></span>
            <div><span className="eyebrow">TASK</span><h2>{mode === "html" ? "AI 正在构建交互演示" : mode === "ai" ? "AI 正在构建演示" : "本地规则工作流"}</h2></div>
          </div>
          <p className="task-summary">{mode === "html" ? "把内容编排成可编辑、可交互并能离线交付的 HTML 演示。" : "把文字、表格和图像整理成一份能讲清楚、能继续修改的 PowerPoint。"}</p>

          <div className="chat-request">
            <span>你的任务</span>
            <strong>{topic}</strong>
            <small>{audience ? `面向 ${audience} · ${slideCount} 页` : `${slideCount} 页演示`}</small>
          </div>

          <div className="assistant-reply" aria-live="polite">
            <span className="assistant-mark"><Sparkles size={13} /></span>
            <p>{steps.some((step) => step.status !== "idle")
              ? isRunning ? "我正在处理这份演示，下面会按实际执行顺序持续更新。" : status
              : "开始后，我会先分析材料，再逐步生成内容、视觉和交互页面。"}</p>
          </div>

          <div className="step-list">
            {steps.filter((step) => step.status !== "idle").map((step) => (
              <WorkflowRow
                key={step.id}
                step={step}
                index={stepOrder.indexOf(step.id)}
                activities={activityEntries.filter((activity) => activity.stepId === step.id)}
                onRetry={step.status === "error" && failedStep === step.id ? mode === "html" ? resumeHtmlPipeline : resumeAiPipeline : undefined}
                retrying={isRunning && failedStep === step.id}
              />
            ))}
          </div>
          <div ref={timelineEndRef} />

          <div className="run-summary">
            <span><BrainCircuit size={14} />{apiCalls + liveApiCalls} 次 API 调用</span>
            <span><ImageIcon size={14} />{generatedCount} 张生成图</span>
          </div>

          <div className="run-area">
            <p>{status}</p>
            {mode !== "local" ? (
              <div className="run-actions">
                <button className="primary-button" onClick={mode === "html" ? failedStep ? resumeHtmlPipeline : () => void runHtmlPipeline() : failedStep ? resumeAiPipeline : () => void runAiPipeline()} disabled={isRunning}>
                  {isRunning ? <Loader2 className="spin" size={16} /> : failedStep ? <RotateCcw size={16} /> : <WandSparkles size={16} />}
                  {isRunning ? "正在执行五阶段…" : mode === "html" ? failedStep ? "重新生成交互演示" : "运行并生成 HTML 演示" : failedStep ? `从“${stepTitle(failedStep)}”继续` : "运行并生成 PPTX"}
                </button>
                {failedStep && mode === "ai" && <button className="restart-button" onClick={restartAiPipeline} disabled={isRunning}>重新开始</button>}
              </div>
            ) : (
              <button className="primary-button" onClick={() => runLocal()}><Sparkles size={16} />生成本地方案</button>
            )}
            <small>{mode === "html" ? "HTML Deck 自动保存到浏览器；模型生成代码不会获得主应用同源权限。" : mode === "ai" ? failedStep ? "检查点保存在当前页面中；继续时不会重复成功的环节和图片。" : "文字和图片会发送到你配置的模型服务。" : "不联网、不需要 Key，所有处理在浏览器完成。"}</small>
          </div>
        </section>
        </div>

        {mode === "html" && htmlSidebarCollapsed && (
          <button className="html-sidebar-reopen" onClick={() => setHtmlSidebarCollapsed(false)} title="展开侧栏" aria-label="展开侧栏"><PanelLeftOpen size={17} /></button>
        )}

        <section className={`artifact-pane ${mode === "html" ? "html-artifact-pane" : ""}`}>
          {mode === "html" ? (
            htmlPreviewPending ? (
              <div className="html-pending-preview" aria-label="HTML 演示预览生成中" />
            ) : (
              <HtmlDeckWorkspace
                deck={htmlDeck}
                onChange={setHtmlDeck}
                onExportHtml={() => void exportCurrentHtmlDeck()}
                onExportPptx={() => void exportCurrentHtmlPptx()}
                exporting={isHtmlExporting}
                onRequestAiEdit={requestHtmlAiEdit}
                aiEditing={isHtmlAiEditing}
              />
            )
          ) : (
          <>
          <div className="artifact-toolbar">
            <div><span className="eyebrow">ARTIFACT</span><h2>{deck.title}</h2></div>
            <div className="artifact-meta"><span>{deck.slides.length} 页</span><span>{currentStyle.name}</span><span>{apiConfig.imageEnabled && apiConfig.imageTextMode === "integrated" ? "融合成片" : "可编辑 PPTX"}</span></div>
          </div>

          <div className="story-strip">
            <span>核心主张</span><strong>{deck.story.thesis}</strong>
            {deck.story.evidenceGaps.length > 0 && <button title={deck.story.evidenceGaps.join("\n")}>{deck.story.evidenceGaps.length} 个证据缺口</button>}
          </div>

          <div className="artifact-stage">
            <button className="stage-nav prev" title="上一页" disabled={selectedSlide === 0} onClick={() => setSelectedSlide((value) => Math.max(0, value - 1))}><ChevronLeft size={18} /></button>
            {currentSlide && <SlideCanvas slide={currentSlide} assets={assets} theme={deck.theme} index={selectedSlide} />}
            <button className="stage-nav next" title="下一页" disabled={selectedSlide >= deck.slides.length - 1} onClick={() => setSelectedSlide((value) => Math.min(deck.slides.length - 1, value + 1))}><ChevronRight size={18} /></button>
          </div>

          <div className="slide-filmstrip">
            {deck.slides.map((slide, index) => (
              <button key={`${slide.title}-${index}`} className={index === selectedSlide ? "active" : ""} onClick={() => setSelectedSlide(index)}>
                <span>{String(index + 1).padStart(2, "0")}</span><strong>{slide.title}</strong>
              </button>
            ))}
          </div>

          {currentSlide && <SlideEditor slide={currentSlide} onChange={updateSlide} />}
          </>
          )}
        </section>
      </div>
    </main>
  );
}

export type { NotebookDeckSpec } from "./types";
export default App;
