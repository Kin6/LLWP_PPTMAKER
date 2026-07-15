import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowDownToLine,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronDown,
  Cloud,
  ClipboardList,
  Cpu,
  Eye,
  FileJson,
  FileText,
  Image as ImageIcon,
  Info,
  KeyRound,
  Loader2,
  RefreshCw,
  Rows3,
  Settings2,
  ShieldCheck,
  Table2,
  UploadCloud,
  Wand2,
  X,
} from "lucide-react";
import { exportNotebookDeck } from "./lib/exportDeck";
import {
  generateAiDeck,
  generateAiImages,
  testApiConnection,
  type ApiConfig,
  type ApiProvider,
} from "./lib/apiClient";

type BranchKey = "text" | "table" | "image";
type SlideLayout = "cover" | "two-column" | "visual-left" | "visual-right" | "section" | "takeaway";

type GeneratedAsset = {
  id: string;
  filename: string;
  url: string;
  prompt: string;
  index: number;
  width?: number;
  height?: number;
  aspectLabel?: string;
  averageColor?: string;
  palette?: string[];
  summary?: string;
};

type NotebookSlideSpec = {
  title: string;
  subtitle?: string;
  layout?: SlideLayout;
  bullets?: string[];
  speakerNotes?: string;
  sourceNotes?: string[];
  imageIndex?: number;
  tableRows?: string[][];
  callouts?: { label: string; value: string }[];
};

export type NotebookDeckSpec = {
  title: string;
  theme?: "dark-executive" | "light-consulting" | "editorial-visual";
  slides: NotebookSlideSpec[];
};

type SourceCard = {
  id: string;
  branch: BranchKey;
  label: string;
  claim: string;
  evidence: string;
  action: string;
  confidence: number;
};

type QualityGate = {
  label: string;
  value: number;
  detail: string;
};

type ParsedTable = {
  rows: string[][];
  header: string[];
  body: string[][];
  numericColumns: { name: string; values: number[]; max: number; min: number; avg: number }[];
};

type LocalDeckDraft = {
  deck: NotebookDeckSpec;
  cards: SourceCard[];
  gates: QualityGate[];
  table: ParsedTable;
  keywords: string[];
};

type GenerationMode = "local" | "ai";
type InspectorTab = "outline" | "evidence" | "quality";

const defaultApiConfig: ApiConfig = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5.4-mini",
  apiKey: "",
  imageEnabled: false,
  imageModel: "gpt-image-2",
  imageCount: 1,
  imageQuality: "medium",
};

const sampleText = `目标：做一个不用外部 API 的 AI PPT 生成器。

核心判断：
1. PPT 的质量不能只看页面好不好看，更要看论证逻辑是否清楚。
2. 用户会输入文字、表格和图片，系统需要先把这些材料拆成观点、证据和视觉参考。
3. 第一版应该以原生可编辑 PPTX 为主，HTML 只做演讲预览，图片只做关键视觉增强。

产品方案：
本地浏览器完成文本拆解、表格解析、图片尺寸与颜色分析，再生成 DeckSpec。最后用 PptxGenJS 输出可编辑 PowerPoint，每页保留标题、正文、表格、图片、注释和来源。`;

const sampleTable = `模块,输入,本地处理,输出
文字分支,主题/长文/会议纪要,分句/关键词/观点提取,主张与论证链
表格分支,CSV/Excel 粘贴,行列解析/数值统计/对比,图表页与数据结论
图片分支,截图/产品图/论文图,尺寸/比例/主色/视觉用途,封面或证据图
渲染分支,DeckSpec,模板排版/PPTXGenJS,可编辑 PPTX`;

const sampleImageBrief = "图片会作为本地视觉证据使用：系统分析尺寸、比例、主色和用途，并把它放入封面、证据页或视觉参考页。";

function App() {
  const [mode, setMode] = useState<GenerationMode>("local");
  const [topic, setTopic] = useState("本地无 API 的 AI PPT 生成器");
  const [audience, setAudience] = useState("产品团队、创业者、内部汇报评审");
  const [slideCount, setSlideCount] = useState(7);
  const [textInput, setTextInput] = useState(sampleText);
  const [tableInput, setTableInput] = useState(sampleTable);
  const [imageBrief, setImageBrief] = useState(sampleImageBrief);
  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [draft, setDraft] = useState<LocalDeckDraft>(() =>
    generateLocalDeck({
      topic: "本地无 API 的 AI PPT 生成器",
      audience: "产品团队、创业者、内部汇报评审",
      slideCount: 7,
      textInput: sampleText,
      tableInput: sampleTable,
      imageBrief: sampleImageBrief,
      assets: [],
    }),
  );
  const [apiConfig, setApiConfig] = useState<ApiConfig>(loadApiConfig);
  const [showApiSettings, setShowApiSettings] = useState(false);
  const [envKeyConfigured, setEnvKeyConfigured] = useState(false);
  const [connectionState, setConnectionState] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [apiCalls, setApiCalls] = useState(0);
  const [selectedSlide, setSelectedSlide] = useState(0);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("outline");
  const [isAnalyzingImages, setAnalyzingImages] = useState(false);
  const [isGenerating, setGenerating] = useState(false);
  const [isExporting, setExporting] = useState(false);
  const [status, setStatus] = useState("准备就绪。输入材料后即可生成可编辑 PPTX。");

  const localPreview = useMemo(
    () => generateLocalDeck({ topic, audience, slideCount, textInput, tableInput, imageBrief, assets }),
    [assets, audience, imageBrief, slideCount, tableInput, textInput, topic],
  );
  const currentSlide = draft.deck.slides[selectedSlide] || draft.deck.slides[0];
  const currentAsset = currentSlide?.imageIndex == null
    ? undefined
    : assets.find((asset) => asset.index === currentSlide.imageIndex);
  const averageScore = average(draft.gates.map((gate) => gate.value));

  useEffect(() => {
    try {
      sessionStorage.setItem("deckforge-api-config", JSON.stringify(apiConfig));
    } catch {
      // Private browsing can disable storage. The in-memory value still works.
    }
  }, [apiConfig]);

  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then((payload) => setEnvKeyConfigured(Boolean(payload?.envKeyConfigured)))
      .catch(() => setEnvKeyConfigured(false));
  }, []);

  const sourceInput = useCallback(
    () => ({ topic, audience, slideCount, textInput, tableInput, imageBrief, assets }),
    [assets, audience, imageBrief, slideCount, tableInput, textInput, topic],
  );

  const selectMode = useCallback((nextMode: GenerationMode) => {
    setMode(nextMode);
    setApiCalls(0);
    setStatus(
      nextMode === "local"
        ? "已切换到本地模式，生成过程不会请求外部模型。"
        : "已切换到 AI 增强模式，请检查模型配置后生成。",
    );
    if (nextMode === "ai") setShowApiSettings(true);
  }, []);

  const generateDeck = useCallback(async () => {
    const input = sourceInput();
    const localContext = generateLocalDeck(input);
    setGenerating(true);
    setSelectedSlide(0);
    setApiCalls(0);

    if (mode === "local") {
      setDraft(localContext);
      setStatus(`已在本地生成 ${localContext.deck.slides.length} 页，外部 API 调用为 0。`);
      setGenerating(false);
      return;
    }

    setStatus("AI 正在整理观点、证据和页面叙事...");
    try {
      const response = await generateAiDeck(apiConfig, {
        topic,
        audience,
        slideCount,
        textInput,
        tableInput,
        imageBrief,
        imageSummaries: assets.map((asset) => `${asset.index}. ${asset.filename}：${asset.summary || "已上传图片"}`),
      });
      let nextDeck = response.deck;
      let nextAssets = assets;
      let callCount = response.meta.apiCalls;
      setDraft({ ...localContext, deck: nextDeck });

      if (apiConfig.imageEnabled && apiConfig.provider === "openai") {
        setStatus("内容结构已完成，正在为关键页面生成配图...");
        try {
          const prompts = createImagePrompts(nextDeck, apiConfig.imageCount);
          const imageResponse = await generateAiImages(apiConfig, prompts);
          const generated = await Promise.all(
            imageResponse.images.map((image, index) =>
              analyzeGeneratedImage(image.url, assets.length + index + 1, image.prompt),
            ),
          );
          nextAssets = [...assets, ...generated];
          const generatedIndexes = generated.map((asset) => asset.index);
          nextDeck = {
            ...nextDeck,
            slides: nextDeck.slides.map((slide, index) => ({
              ...slide,
              imageIndex: slide.imageIndex ?? generatedIndexes[index < generatedIndexes.length ? index : -1],
            })),
          };
          callCount += imageResponse.meta.apiCalls;
          const enrichedContext = generateLocalDeck({ ...input, assets: nextAssets });
          setAssets(nextAssets);
          setDraft({ ...enrichedContext, deck: nextDeck });
        } catch (imageError) {
          setStatus(`内容已生成，但配图失败：${readError(imageError)}`);
        }
      }

      setApiCalls(callCount);
      if (!(apiConfig.imageEnabled && apiConfig.provider === "openai" && callCount === 1)) {
        setStatus(`AI 已生成 ${nextDeck.slides.length} 页，可继续编辑；本次 API 调用 ${callCount} 次。`);
      }
    } catch (error) {
      setStatus(`AI 生成失败：${readError(error)} 当前草稿没有被覆盖。`);
      setShowApiSettings(true);
      setConnectionState("error");
    } finally {
      setGenerating(false);
    }
  }, [apiConfig, assets, audience, imageBrief, mode, slideCount, sourceInput, tableInput, textInput, topic]);

  const testConnection = useCallback(async () => {
    setConnectionState("testing");
    setStatus("正在检查模型地址、Key 和访问权限...");
    try {
      const result = await testApiConnection(apiConfig);
      setConnectionState("success");
      setStatus(`连接成功：${result.provider} / ${result.model}，${result.latencyMs} ms。`);
    } catch (error) {
      setConnectionState("error");
      setStatus(`连接失败：${readError(error)}`);
    }
  }, [apiConfig]);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setAnalyzingImages(true);
    setStatus("正在本地分析图片尺寸、比例和颜色...");
    try {
      const imageFiles = Array.from(files)
        .filter((file) => file.type.startsWith("image/"))
        .slice(0, 10 - assets.length);
      const analyzed = await Promise.all(
        imageFiles.map((file, index) => analyzeImageFile(file, assets.length + index + 1, imageBrief)),
      );
      setAssets((current) => [...current, ...analyzed].slice(0, 10));
      setStatus(`已加入 ${analyzed.length} 张图片，图片分析在浏览器本地完成。`);
    } catch (error) {
      setStatus(readError(error));
    } finally {
      setAnalyzingImages(false);
    }
  }, [assets.length, imageBrief]);

  const removeAsset = useCallback((id: string) => {
    setAssets((current) => current.filter((asset) => asset.id !== id));
  }, []);

  const updateSlide = useCallback((index: number, patch: Partial<NotebookSlideSpec>) => {
    setDraft((current) => ({
      ...current,
      deck: {
        ...current.deck,
        slides: current.deck.slides.map((slide, slideIndex) =>
          slideIndex === index ? { ...slide, ...patch } : slide,
        ),
      },
    }));
  }, []);

  const exportPptx = useCallback(async () => {
    setExporting(true);
    try {
      await exportNotebookDeck(draft.deck, assets);
      setStatus("PPTX 已导出，文字、表格和备注均可继续编辑。");
    } catch (error) {
      setStatus(`PPTX 导出失败：${readError(error)}`);
    } finally {
      setExporting(false);
    }
  }, [assets, draft.deck]);

  const exportDeckSpec = useCallback(() => {
    downloadText(`${safeFileName(topic)}-DeckSpec.json`, JSON.stringify(draft.deck, null, 2), "application/json");
    setStatus("DeckSpec JSON 已导出。");
  }, [draft.deck, topic]);

  const openHtmlPreview = useCallback(() => {
    const html = buildHtmlPreview(draft.deck, draft.cards);
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    window.open(url, "_blank", "noopener,noreferrer");
    setStatus("HTML 演讲预览已打开。");
  }, [draft.cards, draft.deck]);

  const resetSample = useCallback(() => {
    setTopic("本地无 API 的 AI PPT 生成器");
    setAudience("产品团队、创业者、内部汇报评审");
    setSlideCount(7);
    setTextInput(sampleText);
    setTableInput(sampleTable);
    setImageBrief(sampleImageBrief);
    setAssets([]);
    const next = generateLocalDeck({
      topic: "本地无 API 的 AI PPT 生成器",
      audience: "产品团队、创业者、内部汇报评审",
      slideCount: 7,
      textInput: sampleText,
      tableInput: sampleTable,
      imageBrief: sampleImageBrief,
      assets: [],
    });
    setDraft(next);
    setSelectedSlide(0);
    setApiCalls(0);
    setStatus("已恢复示例材料。");
  }, []);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">DF</span>
          <div>
            <strong>DeckForge</strong>
            <small>从材料到可编辑 PPTX</small>
          </div>
        </div>

        <div className="mode-switch" aria-label="生成模式">
          <button
            aria-pressed={mode === "local"}
            className={mode === "local" ? "active" : ""}
            data-testid="mode-local"
            onClick={() => selectMode("local")}
          >
            <Cpu size={15} />
            本地生成
          </button>
          <button
            aria-pressed={mode === "ai"}
            className={mode === "ai" ? "active" : ""}
            data-testid="mode-ai"
            onClick={() => selectMode("ai")}
          >
            <Cloud size={15} />
            AI 增强
          </button>
        </div>

        <div className="header-actions">
          <span className={`privacy-state ${mode}`}>
            {mode === "local" ? <ShieldCheck size={14} /> : <Info size={14} />}
            {mode === "local" ? "材料留在本机" : `API 调用 ${apiCalls}`}
          </span>
          <button
            className="icon-button"
            data-testid="api-settings"
            disabled={mode === "local"}
            onClick={() => setShowApiSettings((current) => !current)}
            title="API 设置"
          >
            <Settings2 size={18} />
          </button>
        </div>
      </header>

      <div className={`status-line ${mode}`} role="status">
        <span className={isGenerating ? "status-dot working" : "status-dot"} />
        <p>{status}</p>
      </div>

      <section className="workspace">
        <aside className="composer-pane">
          <div className="pane-heading">
            <div>
              <span>01 / 输入</span>
              <h1>创建演示文稿</h1>
            </div>
            <button className="text-button" onClick={resetSample}>
              <RefreshCw size={14} /> 示例
            </button>
          </div>

          {mode === "ai" && showApiSettings ? (
            <ApiSettings
              config={apiConfig}
              connectionState={connectionState}
              envKeyConfigured={envKeyConfigured}
              onChange={setApiConfig}
              onTest={testConnection}
            />
          ) : null}

          <div className="brief-grid">
            <label className="field field-wide">
              <span>PPT 主题</span>
              <input value={topic} onChange={(event) => setTopic(event.target.value)} />
            </label>
            <label className="field">
              <span>目标受众</span>
              <input value={audience} onChange={(event) => setAudience(event.target.value)} />
            </label>
            <label className="field page-count-field">
              <span>页数</span>
              <input
                max={12}
                min={4}
                type="number"
                value={slideCount}
                onChange={(event) => setSlideCount(clamp(Number(event.target.value), 4, 12))}
              />
            </label>
          </div>

          <MaterialSection
            count={`${textInput.trim().length} 字`}
            icon={<FileText size={16} />}
            title="文字材料"
          >
            <textarea
              className="text-material"
              placeholder="粘贴长文、会议纪要、需求或论文段落"
              value={textInput}
              onChange={(event) => setTextInput(event.target.value)}
            />
          </MaterialSection>

          <MaterialSection
            count={`${localPreview.table.body.length} 行`}
            icon={<Table2 size={16} />}
            title="表格材料"
          >
            <textarea
              className="table-material"
              placeholder="粘贴 CSV、Markdown 表格或 Excel 单元格"
              spellCheck={false}
              value={tableInput}
              onChange={(event) => setTableInput(event.target.value)}
            />
          </MaterialSection>

          <MaterialSection
            count={`${assets.length} 张`}
            icon={<ImageIcon size={16} />}
            title="图片材料"
          >
            <textarea
              className="image-brief"
              placeholder="说明图片希望表达什么，以及适合放在哪一页"
              value={imageBrief}
              onChange={(event) => setImageBrief(event.target.value)}
            />
            <label className="upload-button">
              <UploadCloud size={16} />
              {isAnalyzingImages ? "正在分析..." : "选择图片"}
              <input
                accept="image/*"
                multiple
                type="file"
                onChange={(event) => handleFiles(event.target.files)}
              />
            </label>
            {assets.length ? (
              <div className="asset-strip">
                {assets.map((asset) => (
                  <figure key={asset.id}>
                    <img alt={asset.filename} src={asset.url} />
                    <button onClick={() => removeAsset(asset.id)} title="移除图片"><X size={12} /></button>
                    <figcaption>{asset.aspectLabel}</figcaption>
                  </figure>
                ))}
              </div>
            ) : null}
          </MaterialSection>

          <button
            className="generate-button"
            data-testid="generate-button"
            disabled={isGenerating}
            onClick={generateDeck}
          >
            {isGenerating ? <Loader2 className="spin" size={17} /> : <Wand2 size={17} />}
            {isGenerating ? "正在生成" : mode === "local" ? "本地生成 PPT" : "AI 生成 PPT"}
          </button>
          <p className="generate-note">
            {mode === "local"
              ? "规则分析、图片取色和 PPTX 导出都在本机完成。"
              : "输入材料会发送给当前配置的模型服务，图片 API 只有在单独开启后才调用。"}
          </p>
        </aside>

        <section className="result-pane">
          <div className="result-heading">
            <div>
              <span>02 / 检查与导出</span>
              <h2>{draft.deck.title}</h2>
            </div>
            <div className="summary-stats" aria-label="生成结果摘要">
              <SummaryStat label="逻辑" value={averageScore} />
              <SummaryStat label="页面" value={draft.deck.slides.length} />
              <SummaryStat label="图片" value={assets.length} />
            </div>
            <div className="export-toolbar">
              <button className="icon-button" onClick={exportDeckSpec} title="导出 DeckSpec JSON">
                <FileJson size={17} />
              </button>
              <button className="icon-button" onClick={openHtmlPreview} title="打开 HTML 演讲预览">
                <Eye size={17} />
              </button>
              <button
                className="export-button"
                data-testid="export-pptx"
                disabled={isExporting}
                onClick={exportPptx}
              >
                {isExporting ? <Loader2 className="spin" size={16} /> : <ArrowDownToLine size={16} />}
                导出 PPTX
              </button>
            </div>
          </div>

          <div className="editor-workspace">
            <nav className="slide-rail" aria-label="幻灯片列表">
              {draft.deck.slides.map((slide, index) => (
                <button
                  className={selectedSlide === index ? "slide-thumb active" : "slide-thumb"}
                  key={`${slide.title}-${index}`}
                  onClick={() => setSelectedSlide(index)}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>{slide.title}</strong>
                    <small>{slide.layout || "two-column"}</small>
                  </div>
                </button>
              ))}
            </nav>

            <div className="slide-stage">
              <div className="stage-toolbar">
                <span>第 {selectedSlide + 1} 页</span>
                <span>{currentSlide?.layout || "two-column"}</span>
              </div>
              <SlideCanvas slide={currentSlide} asset={currentAsset} index={selectedSlide} mode={mode} />

              {currentSlide ? (
                <div className="slide-editor">
                  <label className="field">
                    <span>标题</span>
                    <input
                      value={currentSlide.title}
                      onChange={(event) => updateSlide(selectedSlide, { title: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>副标题</span>
                    <input
                      value={currentSlide.subtitle || ""}
                      onChange={(event) => updateSlide(selectedSlide, { subtitle: event.target.value })}
                    />
                  </label>
                  <label className="field field-wide">
                    <span>页面要点，每行一条</span>
                    <textarea
                      value={(currentSlide.bullets || []).join("\n")}
                      onChange={(event) => updateSlide(selectedSlide, {
                        bullets: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean),
                      })}
                    />
                  </label>
                </div>
              ) : null}
            </div>
          </div>

          <DiagnosticsPanel
            cards={draft.cards}
            deck={draft.deck}
            gates={draft.gates}
            selectedTab={inspectorTab}
            onSelectTab={setInspectorTab}
          />
        </section>
      </section>
    </main>
  );
}

function ApiSettings({
  config,
  connectionState,
  envKeyConfigured,
  onChange,
  onTest,
}: {
  config: ApiConfig;
  connectionState: "idle" | "testing" | "success" | "error";
  envKeyConfigured: boolean;
  onChange: (config: ApiConfig) => void;
  onTest: () => void;
}) {
  const changeProvider = (provider: ApiProvider) => {
    const preset = providerPreset(provider);
    onChange({
      ...config,
      provider,
      baseUrl: preset.baseUrl,
      model: preset.model,
      imageEnabled: provider === "openai" ? config.imageEnabled : false,
    });
  };

  return (
    <section className="api-settings-panel" data-testid="api-panel">
      <div className="api-panel-heading">
        <div>
          <KeyRound size={16} />
          <strong>API 设置</strong>
        </div>
        <span className={`connection-label ${connectionState}`}>
          {connectionState === "success" ? <Check size={13} /> : null}
          {connectionState === "testing" ? "检查中" : connectionState === "success" ? "已连接" : connectionState === "error" ? "连接失败" : "未检查"}
        </span>
      </div>

      <div className="api-grid">
        <label className="field">
          <span>内容模型服务</span>
          <select value={config.provider} onChange={(event) => changeProvider(event.target.value as ApiProvider)}>
            <option value="openai">OpenAI Responses</option>
            <option value="compatible">OpenAI 兼容接口</option>
            <option value="ollama">Ollama 本地</option>
          </select>
        </label>
        <label className="field">
          <span>模型</span>
          <input value={config.model} onChange={(event) => onChange({ ...config, model: event.target.value })} />
        </label>
        <label className="field field-wide">
          <span>API Base URL</span>
          <input value={config.baseUrl} onChange={(event) => onChange({ ...config, baseUrl: event.target.value })} />
        </label>
        <label className="field field-wide">
          <span>API Key</span>
          <input
            data-testid="api-key"
            placeholder={config.provider === "ollama" ? "本地 Ollama 不需要 Key" : envKeyConfigured ? "服务器环境变量已配置，可留空" : "sk-..."}
            type="password"
            value={config.apiKey}
            onChange={(event) => onChange({ ...config, apiKey: event.target.value })}
          />
          <small>
            {config.provider === "ollama"
              ? "请求只发往本机 Ollama 地址。"
              : envKeyConfigured
                ? "当前可使用 .env.local 中的 OPENAI_API_KEY。"
                : "页面填写的 Key 只保存在当前标签页会话。"}
          </small>
        </label>
      </div>

      <div className="api-options-row">
        <label className={`toggle-row ${config.provider !== "openai" ? "disabled" : ""}`}>
          <input
            checked={config.imageEnabled}
            disabled={config.provider !== "openai"}
            type="checkbox"
            onChange={(event) => onChange({ ...config, imageEnabled: event.target.checked })}
          />
          <span className="toggle-control" aria-hidden="true" />
          <span>
            <strong>生成配图</strong>
            <small>{config.provider === "openai" ? "调用独立图片 API" : "当前仅支持 OpenAI 模式"}</small>
          </span>
        </label>
        {config.imageEnabled && config.provider === "openai" ? (
          <>
            <label className="compact-field">
              <span>图片模型</span>
              <input value={config.imageModel} onChange={(event) => onChange({ ...config, imageModel: event.target.value })} />
            </label>
            <label className="compact-field count-field">
              <span>张数</span>
              <select
                value={config.imageCount}
                onChange={(event) => onChange({ ...config, imageCount: Number(event.target.value) })}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
          </>
        ) : null}
      </div>

      <div className="api-panel-actions">
        <details className="api-guide">
          <summary>需要哪些 API，Key 放在哪里 <ChevronDown size={14} /></summary>
          <div>
            <p><strong>内容生成：</strong>OpenAI 使用 <code>/v1/responses</code>；兼容服务和 Ollama 使用 <code>/v1/chat/completions</code>。</p>
            <p><strong>图片生成：</strong>可选，使用 <code>/v1/images/generations</code>。关闭配图后不会产生图片费用。</p>
            <p><strong>Key：</strong>推荐在项目根目录的 <code>.env.local</code> 中填写 <code>OPENAI_API_KEY</code>；也可填在上方密码框，仅保存到当前浏览器会话。</p>
          </div>
        </details>
        <button className="test-button" disabled={connectionState === "testing"} onClick={onTest}>
          {connectionState === "testing" ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
          测试连接
        </button>
      </div>
    </section>
  );
}

function MaterialSection({ children, count, icon, title }: { children: ReactNode; count: string; icon: ReactNode; title: string }) {
  return (
    <section className="material-section">
      <div className="material-heading">
        <div>{icon}<strong>{title}</strong></div>
        <span>{count}</span>
      </div>
      {children}
    </section>
  );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return <span><strong>{value}</strong><small>{label}</small></span>;
}

function SlideCanvas({
  asset,
  index,
  mode,
  slide,
}: {
  asset?: GeneratedAsset;
  index: number;
  mode: GenerationMode;
  slide?: NotebookSlideSpec;
}) {
  if (!slide) return <div className="slide-canvas empty">暂无页面</div>;
  return (
    <div className={`slide-canvas layout-${slide.layout || "two-column"}`}>
      <div className="canvas-meta">
        <span>DECKFORGE / {String(index + 1).padStart(2, "0")}</span>
        <span>{mode === "local" ? "LOCAL" : "AI"}</span>
      </div>
      <div className="canvas-copy">
        <h3>{slide.title}</h3>
        {slide.subtitle ? <p>{slide.subtitle}</p> : null}
        {slide.bullets?.length ? (
          <ul>{slide.bullets.slice(0, 5).map((bullet, bulletIndex) => <li key={`${bullet}-${bulletIndex}`}>{bullet}</li>)}</ul>
        ) : null}
      </div>
      {asset ? <img alt={asset.filename} src={asset.url} /> : <div className="canvas-accent" aria-hidden="true"><i /><i /><i /></div>}
    </div>
  );
}

function DiagnosticsPanel({
  cards,
  deck,
  gates,
  onSelectTab,
  selectedTab,
}: {
  cards: SourceCard[];
  deck: NotebookDeckSpec;
  gates: QualityGate[];
  onSelectTab: (tab: InspectorTab) => void;
  selectedTab: InspectorTab;
}) {
  return (
    <section className="diagnostics-panel">
      <div className="diagnostic-tabs" role="tablist">
        <button className={selectedTab === "outline" ? "active" : ""} onClick={() => onSelectTab("outline")}><Rows3 size={14} />结构</button>
        <button className={selectedTab === "evidence" ? "active" : ""} onClick={() => onSelectTab("evidence")}><ClipboardList size={14} />证据</button>
        <button className={selectedTab === "quality" ? "active" : ""} onClick={() => onSelectTab("quality")}><BarChart3 size={14} />质量</button>
      </div>
      {selectedTab === "outline" ? (
        <div className="outline-list">
          {deck.slides.map((slide, index) => (
            <div key={`${slide.title}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><strong>{slide.title}</strong><small>{slide.subtitle}</small></div>
          ))}
        </div>
      ) : null}
      {selectedTab === "evidence" ? (
        <div className="evidence-list">
          {cards.slice(0, 8).map((card) => (
            <div key={card.id}><span>{card.label}</span><strong>{card.claim}</strong><p>{card.evidence}</p><em>{card.confidence}</em></div>
          ))}
        </div>
      ) : null}
      {selectedTab === "quality" ? (
        <div className="quality-list">
          {gates.map((gate) => (
            <div key={gate.label}>
              <span><strong>{gate.label}</strong><small>{gate.detail}</small></span>
              <b>{gate.value}</b>
              <i><span style={{ width: `${gate.value}%` }} /></i>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function loadApiConfig(): ApiConfig {
  try {
    const saved = JSON.parse(sessionStorage.getItem("deckforge-api-config") || "null");
    return saved ? { ...defaultApiConfig, ...saved } : defaultApiConfig;
  } catch {
    return defaultApiConfig;
  }
}

function providerPreset(provider: ApiProvider) {
  if (provider === "ollama") return { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b" };
  if (provider === "compatible") return { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" };
  return { baseUrl: "https://api.openai.com/v1", model: "gpt-5.4-mini" };
}

function createImagePrompts(deck: NotebookDeckSpec, count: number) {
  return deck.slides.slice(0, clamp(count, 1, 3)).map((slide) =>
    `为中文演示文稿《${deck.title}》的页面“${slide.title}”创作一张 16:9 横版专业视觉图。${slide.subtitle || ""}。画面清晰、主体明确、可用于商业汇报；不要在图片中生成任何文字、字母、数字、图表标签或水印。`,
  );
}

async function analyzeGeneratedImage(url: string, index: number, prompt: string): Promise<GeneratedAsset> {
  try {
    const image = await loadImage(url);
    let palette = ["#d6533f", "#257b8b", "#61724f"];
    try {
      palette = getImagePalette(image);
    } catch {
      // Cross-origin image URLs can be displayed but not sampled by canvas.
    }
    return {
      id: makeId("ai-img"),
      filename: `AI 配图 ${index}`,
      url,
      prompt,
      index,
      width: image.naturalWidth,
      height: image.naturalHeight,
      aspectLabel: "横图",
      averageColor: palette[0],
      palette,
      summary: `由图片 API 生成的 16:9 页面视觉，提示词：${compactText(prompt, 72)}`,
    };
  } catch {
    return {
      id: makeId("ai-img"),
      filename: `AI 配图 ${index}`,
      url,
      prompt,
      index,
      aspectLabel: "横图",
      averageColor: "#d6533f",
      palette: ["#d6533f", "#257b8b", "#61724f"],
      summary: "由图片 API 生成的页面视觉。",
    };
  }
}

function readError(error: unknown) {
  return error instanceof Error ? error.message : "发生未知错误。";
}

function generateLocalDeck(input: {
  topic: string;
  audience: string;
  slideCount: number;
  textInput: string;
  tableInput: string;
  imageBrief: string;
  assets: GeneratedAsset[];
}): LocalDeckDraft {
  const sentences = extractSentences(input.textInput);
  const claims = rankSentences(sentences);
  const table = parseTable(input.tableInput);
  const textCards = buildTextCards(claims, input.topic);
  const tableCards = buildTableCards(table);
  const imageCards = buildImageCards(input.assets, input.imageBrief);
  const cards = [...textCards, ...tableCards, ...imageCards];
  const keywords = extractKeywords(input.textInput, input.topic);
  const slides = buildSlides(input, claims, table, cards, keywords);
  const deck: NotebookDeckSpec = {
    title: input.topic || "本地生成 PPT",
    theme: input.assets.length ? "editorial-visual" : "light-consulting",
    slides: slides.slice(0, input.slideCount),
  };
  return {
    deck,
    cards,
    gates: buildQualityGates(input, deck, cards, table),
    table,
    keywords,
  };
}

function buildSlides(
  input: {
    topic: string;
    audience: string;
    slideCount: number;
    textInput: string;
    imageBrief: string;
    assets: GeneratedAsset[];
  },
  claims: string[],
  table: ParsedTable,
  cards: SourceCard[],
  keywords: string[],
): NotebookSlideSpec[] {
  const mainClaim = claims[0] || `${input.topic} 需要先保证内容逻辑，再进入页面设计。`;
  const problemClaim =
    claims.find((item) => /问题|痛点|不足|风险|难|不能|成本|失败/.test(item)) ||
    "当前材料需要被拆成清晰的观点、证据和行动建议。";
  const solutionClaim =
    claims.find((item) => /方案|建议|路线|架构|实现|生成|输出|应该|需要/.test(item)) ||
    "推荐使用本地 DeckSpec 作为内容和渲染之间的中间层。";
  const imageSummary = input.assets.length
    ? input.assets.map((asset) => `${asset.filename}: ${asset.summary || asset.aspectLabel}`).join("；")
    : input.imageBrief;
  const tableSummary = table.body.length
    ? `表格包含 ${table.body.length} 行、${table.header.length || table.rows[0]?.length || 0} 列，可形成结构化证据页。`
    : "当前没有结构化表格，系统会以文字材料为主生成。";
  const tableRows = table.rows.length ? table.rows.slice(0, 6).map((row) => row.slice(0, 4)) : undefined;

  const slides: NotebookSlideSpec[] = [
    {
      title: input.topic || "本地生成 PPT",
      subtitle: `面向：${input.audience || "通用受众"}`,
      layout: "cover",
      bullets: compactList([mainClaim, solutionClaim, tableSummary], 3),
      speakerNotes: "开场页说明主题、受众和本地无 API 的生成方式。",
      sourceNotes: sourceNotes(cards, ["text", "table", "image"]),
      imageIndex: input.assets[0]?.index,
    },
    {
      title: `核心结论：${shortTitle(mainClaim)}`,
      subtitle: "从输入材料自动抽取的主线",
      layout: "two-column",
      bullets: compactList([mainClaim, ...claims.slice(1, 5)], 5),
      speakerNotes: "这一页把输入文字压缩成可讲述的主要判断。",
      sourceNotes: sourceNotes(cards, ["text"]),
      callouts: [
        { label: "文字证据", value: String(cards.filter((card) => card.branch === "text").length) },
        { label: "关键词", value: keywords.slice(0, 3).join(" / ") || "local" },
      ],
    },
    {
      title: `问题：${shortTitle(problemClaim)}`,
      subtitle: "先把用户材料中的矛盾和缺口讲清楚",
      layout: input.assets.length ? "visual-right" : "two-column",
      bullets: compactList([problemClaim, ...claims.filter((item) => item !== problemClaim).slice(0, 4)], 5),
      speakerNotes: "问题页解释为什么需要这个方案，以及当前状态有什么不足。",
      sourceNotes: sourceNotes(cards, ["text", "image"]),
      imageIndex: input.assets[1]?.index || input.assets[0]?.index,
    },
    {
      title: table.body.length ? "数据证据：表格材料转成可讲述结论" : "证据结构：把材料转成可追溯卡片",
      subtitle: tableSummary,
      layout: "two-column",
      bullets: table.numericColumns.length
        ? table.numericColumns.slice(0, 4).map((column) => `${column.name}：最大 ${column.max}，最小 ${column.min}，均值 ${column.avg}`)
        : compactList(table.body.slice(0, 4).map((row) => row.join(" / ")).concat("每个结论都保留来源，方便用户回查。"), 5),
      speakerNotes: "表格页展示结构化材料如何变成结论，而不是只复制原始数据。",
      sourceNotes: sourceNotes(cards, ["table"]),
      tableRows,
      callouts: [
        { label: "行数", value: String(table.body.length || table.rows.length) },
        { label: "列数", value: String(table.header.length || table.rows[0]?.length || 0) },
      ],
    },
    {
      title: input.assets.length ? "图片证据：本地分析视觉材料" : "视觉策略：图片只做增强，不替代可编辑内容",
      subtitle: imageSummary,
      layout: input.assets.length ? "visual-left" : "two-column",
      bullets: input.assets.length
        ? input.assets.slice(0, 4).map((asset) => `${asset.filename}：${asset.summary}`)
        : [
            "没有上传图片时，系统仍然可以生成纯文本和表格型 PPT。",
            "上传图片后会本地分析尺寸、比例、主色，并自动放入合适页面。",
            "图片作为证据或视觉参考，文字和结构仍保持可编辑。",
          ],
      speakerNotes: "图片页展示上传素材如何进入 PPT。当前版本不调用视觉 API，只做本地元信息与颜色分析。",
      sourceNotes: sourceNotes(cards, ["image"]),
      imageIndex: input.assets[0]?.index,
    },
    {
      title: `方案：${shortTitle(solutionClaim)}`,
      subtitle: "本地生成器的可用闭环",
      layout: "section",
      bullets: [
        "输入层：文字、表格、图片分支分别处理。",
        "逻辑层：生成观点、证据、页面角色和质量门禁。",
        "渲染层：输出 DeckSpec、HTML 预览和可编辑 PPTX。",
        "全流程不请求外部模型或云端 API。",
      ],
      speakerNotes: "方案页解释这个本地版本的架构闭环。",
      sourceNotes: sourceNotes(cards, ["text", "table", "image"]),
    },
    {
      title: "行动计划：先让闭环可用，再增强智能",
      subtitle: "第一版关注可交付，下一步再接本地 LLM/OCR",
      layout: "takeaway",
      bullets: [
        "当前版本已经支持文本/表格/图片到 PPTX 的本地闭环。",
        "下一步可接 Ollama 或 LM Studio 做更强的本地改写。",
        "再下一步可接本地 OCR/VLM，把图片中的文字和对象也解析出来。",
        "最终再对接模板系统和 ppt-master 级 DrawingML 渲染。",
      ],
      speakerNotes: "结尾页给出产品演进路径。",
      sourceNotes: sourceNotes(cards, ["text"]),
      callouts: [
        { label: "外部 API", value: "0" },
        { label: "主交付", value: "PPTX" },
      ],
    },
    {
      title: "附录：自动抽取关键词",
      subtitle: keywords.slice(0, 8).join(" / ") || "暂无关键词",
      layout: "two-column",
      bullets: keywords.slice(0, 8).map((keyword) => `关键词：${keyword}`),
      speakerNotes: "附录页展示本地关键词结果，方便用户检查生成依据。",
      sourceNotes: sourceNotes(cards, ["text", "table", "image"]),
    },
  ];

  while (slides.length < input.slideCount) {
    slides.push({
      title: `补充页 ${slides.length + 1}：${keywords[slides.length % Math.max(keywords.length, 1)] || input.topic}`,
      subtitle: "根据输入材料自动补充的可编辑页面",
      layout: "two-column",
      bullets: compactList(claims.slice(0, 5), 5),
      speakerNotes: "补充页用于满足目标页数。",
      sourceNotes: sourceNotes(cards, ["text"]),
    });
  }

  return slides;
}

function buildTextCards(claims: string[], topic: string): SourceCard[] {
  const selected = claims.length ? claims.slice(0, 4) : [`${topic} 需要清晰的内容逻辑。`];
  return selected.map((claim, index) => ({
    id: `text-${index + 1}`,
    branch: "text",
    label: "文字",
    claim: compactText(claim, 42),
    evidence: compactText(claim, 86),
    action: index === 0 ? "作为主结论" : "拆成论证页",
    confidence: clamp(84 + index * 3, 70, 96),
  }));
}

function buildTableCards(table: ParsedTable): SourceCard[] {
  if (!table.rows.length) {
    return [
      {
        id: "table-empty",
        branch: "table",
        label: "表格",
        claim: "暂无表格材料",
        evidence: "粘贴 CSV、Markdown 表格或 Excel 区域后，会生成数据证据页。",
        action: "等待输入",
        confidence: 42,
      },
    ];
  }
  const firstRows = table.body.slice(0, 3).map((row) => row[0]).filter(Boolean).join(" / ");
  return [
    {
      id: "table-1",
      branch: "table",
      label: "表格",
      claim: `识别 ${table.body.length || table.rows.length} 行结构化数据`,
      evidence: table.header.length ? `字段：${table.header.slice(0, 5).join("、")}` : "已识别多列数据。",
      action: "生成数据页",
      confidence: 90,
    },
    {
      id: "table-2",
      branch: "table",
      label: "表格",
      claim: firstRows || "可形成对比矩阵",
      evidence: table.numericColumns.length
        ? `数值列：${table.numericColumns.map((column) => column.name).join("、")}`
        : "表格可用于对比、分类和路线选择。",
      action: "生成对比结论",
      confidence: table.numericColumns.length ? 92 : 84,
    },
  ];
}

function buildImageCards(assets: GeneratedAsset[], brief: string): SourceCard[] {
  if (!assets.length) {
    return [
      {
        id: "image-empty",
        branch: "image",
        label: "图片",
        claim: "暂无上传图片",
        evidence: compactText(brief, 86),
        action: "可选增强",
        confidence: 50,
      },
    ];
  }
  return assets.slice(0, 4).map((asset, index) => ({
    id: `image-${index + 1}`,
    branch: "image",
    label: "图片",
    claim: asset.filename,
    evidence: asset.summary || `${asset.width}x${asset.height}，主色 ${asset.averageColor}`,
    action: index === 0 ? "封面/视觉页" : "证据页",
    confidence: 86,
  }));
}

function buildQualityGates(
  input: { textInput: string; tableInput: string; assets: GeneratedAsset[] },
  deck: NotebookDeckSpec,
  cards: SourceCard[],
  table: ParsedTable,
): QualityGate[] {
  const textScore = clamp(Math.round(input.textInput.trim().length / 8), 45, 100);
  const branchCount = new Set(cards.map((card) => card.branch).filter((branch) => branch !== "image" || input.assets.length)).size;
  const evidenceScore = Math.round(
    (deck.slides.filter((slide) => (slide.sourceNotes || []).length > 0).length / Math.max(deck.slides.length, 1)) * 100,
  );
  return [
    {
      label: "文字充足度",
      value: textScore,
      detail: "输入文字越完整，生成主线越稳定",
    },
    {
      label: "证据覆盖",
      value: evidenceScore,
      detail: "每页是否绑定来源材料",
    },
    {
      label: "分支覆盖",
      value: clamp(branchCount * 32, 45, 100),
      detail: "文字、表格、图片是否进入生成流程",
    },
    {
      label: "表格可用性",
      value: table.rows.length ? clamp(72 + table.body.length * 4, 72, 96) : 45,
      detail: "能否生成数据页或对比矩阵",
    },
    {
      label: "可编辑性",
      value: 97,
      detail: "默认输出原生 PPTX 对象",
    },
  ];
}

function extractSentences(input: string) {
  return input
    .replace(/\r/g, "\n")
    .split(/[\n。！？!?；;]+/)
    .map((line) => line.replace(/^[-*#\d.\s、]+/, "").trim())
    .filter((line) => line.length >= 4);
}

function rankSentences(sentences: string[]) {
  return [...sentences]
    .sort((a, b) => scoreSentence(b) - scoreSentence(a))
    .slice(0, 10);
}

function scoreSentence(sentence: string) {
  let score = Math.min(sentence.length, 90) / 6;
  if (/[0-9%％]/.test(sentence)) score += 10;
  if (/目标|结论|核心|判断|方案|建议|路线|架构|实现|输出|用户|质量|成本|风险|问题|痛点|优势|交付/.test(sentence)) {
    score += 14;
  }
  if (sentence.length > 80) score -= 6;
  return score;
}

function parseTable(input: string): ParsedTable {
  const rows = input
    .split(/\n+/)
    .map((row) => row.trim())
    .filter(Boolean)
    .filter((row) => !/^\|?\s*-{3,}/.test(row))
    .map((row) =>
      row
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split(/\t|,|，|\|/)
        .map((cell) => cell.trim())
        .filter(Boolean),
    )
    .filter((row) => row.length > 1);
  const header = rows[0] || [];
  const body = rows.slice(1);
  const numericColumns = header
    .map((name, columnIndex) => {
      const values = body
        .map((row) => parseNumber(row[columnIndex]))
        .filter((value): value is number => Number.isFinite(value));
      if (!values.length) return null;
      const sum = values.reduce((total, value) => total + value, 0);
      return {
        name,
        values,
        max: Math.max(...values),
        min: Math.min(...values),
        avg: Math.round((sum / values.length) * 100) / 100,
      };
    })
    .filter((column): column is ParsedTable["numericColumns"][number] => Boolean(column));
  return { rows, header, body, numericColumns };
}

function parseNumber(value: string | undefined) {
  if (!value) return Number.NaN;
  const normalized = value.replace(/[%％,，]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : Number.NaN;
}

function extractKeywords(text: string, topic: string) {
  const tokens = `${topic}\n${text}`
    .split(/[\s,，。！？；;:：、()（）[\]【】"'“”]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token.length <= 18)
    .filter((token) => !/^(以及|然后|但是|如果|因为|所以|一个|这个|那个|我们|他们|可以|需要|应该|进行|通过)$/.test(token));
  const counts = new Map<string, number>();
  tokens.forEach((token) => counts.set(token, (counts.get(token) || 0) + 1));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 12)
    .map(([token]) => token);
}

async function analyzeImageFile(file: File, index: number, brief: string): Promise<GeneratedAsset> {
  const url = URL.createObjectURL(file);
  const image = await loadImage(url);
  const palette = getImagePalette(image);
  const aspect = image.naturalWidth / Math.max(image.naturalHeight, 1);
  const aspectLabel = aspect > 1.25 ? "横图" : aspect < 0.8 ? "竖图" : "方图";
  return {
    id: makeId("img"),
    filename: file.name,
    url,
    prompt: brief,
    index,
    width: image.naturalWidth,
    height: image.naturalHeight,
    aspectLabel,
    averageColor: palette[0],
    palette,
    summary: `${image.naturalWidth}x${image.naturalHeight} ${aspectLabel}，主色 ${palette[0]}，适合做${aspect > 1.25 ? "横版视觉页" : "局部证据或参考图"}`,
  };
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取图片。"));
    image.src = url;
  });
}

function getImagePalette(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  const size = 48;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return ["#0fa9bf", "#f15b44", "#43a85b"];
  context.drawImage(image, 0, 0, size, size);
  const data = context.getImageData(0, 0, size, size).data;
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  for (let index = 0; index < data.length; index += 16) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const a = data[index + 3];
    if (a < 180) continue;
    if (r > 245 && g > 245 && b > 245) continue;
    const key = `${Math.round(r / 32)}-${Math.round(g / 32)}-${Math.round(b / 32)}`;
    const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  const colors = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((bucket) =>
      rgbToHex(
        Math.round(bucket.r / bucket.count),
        Math.round(bucket.g / bucket.count),
        Math.round(bucket.b / bucket.count),
      ),
    );
  return colors.length ? colors : ["#0fa9bf", "#f15b44", "#43a85b"];
}

function buildHtmlPreview(deck: NotebookDeckSpec, cards: SourceCard[]) {
  const slides = deck.slides
    .map(
      (slide, index) => `<section class="slide">
  <span>${String(index + 1).padStart(2, "0")}</span>
  <h1>${escapeHtml(slide.title)}</h1>
  <p>${escapeHtml(slide.subtitle || "")}</p>
  <ul>${(slide.bullets || []).map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>
  <footer>${(slide.sourceNotes || []).map(escapeHtml).join(" · ")}</footer>
</section>`,
    )
    .join("");
  const sources = cards.map((card) => `<li><b>${escapeHtml(card.label)}</b> ${escapeHtml(card.claim)}</li>`).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(deck.title)}</title>
  <style>
    body{margin:0;background:#10191d;color:#f8fbfc;font-family:Inter,Arial,"Microsoft YaHei",sans-serif}
    .slide{min-height:100vh;display:grid;align-content:center;padding:7vw 9vw;border-bottom:1px solid #314146}
    span{color:#29bfd1;font-weight:900}
    h1{font-size:clamp(34px,5.8vw,76px);line-height:1.05;margin:.36em 0;max-width:1040px}
    p{font-size:clamp(17px,2vw,28px);color:#c7d5da;max-width:900px}
    ul{font-size:clamp(16px,1.45vw,23px);line-height:1.58;max-width:960px}
    footer{margin-top:40px;color:#91a3aa;font-size:14px}
    .sources{padding:48px 9vw;background:#f6f8f9;color:#10191d}
  </style>
</head>
<body>
${slides}
<section class="sources"><h2>本地来源卡</h2><ul>${sources}</ul></section>
</body>
</html>`;
}

function sourceNotes(cards: SourceCard[], branches: BranchKey[]) {
  return cards
    .filter((card) => branches.includes(card.branch))
    .slice(0, 4)
    .map((card) => `${card.label}: ${card.claim}`);
}

function compactList(items: string[], limit: number) {
  return items
    .filter(Boolean)
    .map((item) => compactText(item, 92))
    .slice(0, limit);
}

function shortTitle(value: string) {
  return compactText(value.replace(/^目标[:：]?/, "").replace(/^核心判断[:：]?/, ""), 24);
}

function compactText(value: string, max: number) {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function average(values: number[]) {
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function makeId(prefix: string) {
  if ("randomUUID" in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function safeFileName(value: string) {
  return value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 80) || "DeckForge";
}

function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default App;
