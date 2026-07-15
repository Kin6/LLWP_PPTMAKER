import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Cloud,
  Crop,
  FileText,
  Image as ImageIcon,
  KeyRound,
  Layers3,
  Loader2,
  MonitorUp,
  Plus,
  Settings2,
  Sparkles,
  Table2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import { exportNotebookDeck } from "./lib/exportDeck";
import { buildLocalDeck, parseTable } from "./lib/localPlanner";
import {
  decomposeAiImages,
  generateAiDeck,
  generateAiImages,
  testApiConnection,
  type ApiConfig,
  type ApiProvider,
  type ApiSourceImage,
  type DecompositionResult,
  type ImageJob,
} from "./lib/apiClient";
import {
  styleProfiles,
  type GeneratedAsset,
  type NotebookDeckSpec,
  type NotebookSlideSpec,
  type NormalizedRect,
} from "./types";

type Mode = "local" | "ai";
type SourceTab = "text" | "table" | "image";
type StepId = "logic" | "image" | "decompose" | "assemble" | "export";
type StepStatus = "idle" | "running" | "done" | "skipped" | "error";

type WorkflowStep = {
  id: StepId;
  title: string;
  engine: string;
  status: StepStatus;
  detail: string;
};

const defaultApiConfig: ApiConfig = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5.4-mini",
  apiKey: "",
  imageEnabled: true,
  imageBaseUrl: "https://api.openai.com/v1",
  imageApiKey: "",
  imageModel: "gpt-image-2",
  imageCount: 2,
  imageQuality: "medium",
};

const initialSteps: WorkflowStep[] = [
  { id: "logic", title: "理清内容逻辑", engine: "Responses · 结构化 DeckSpec", status: "idle", detail: "判断受众、结论、证据和叙事弧" },
  { id: "image", title: "生成主题视觉", engine: "GPT Image 2 · 多参考图编辑", status: "idle", detail: "用户内容图 + 内置风格引导图" },
  { id: "decompose", title: "拆解视觉部件", engine: "视觉模型 + Canvas", status: "idle", detail: "识别安全区并裁出独立图片对象" },
  { id: "assemble", title: "组装页面对象", engine: "原生文字、表格与图片", status: "idle", detail: "把内容逻辑映射到可编辑页面" },
  { id: "export", title: "生成可编辑 PPTX", engine: "PptxGenJS", status: "idle", detail: "输出文本框、表格、图片与讲稿备注" },
];

const sampleText = `我们希望建立一个真正可交付的 AI PPT 制作器。它必须先理解受众要做什么决定，再把零散材料整理成核心结论、证据链和行动建议。

视觉质量不能只依赖固定模板。系统可以让图像模型参考用户图片，同时从内置风格知识库中选择一张高质量引导图，统一构图、色彩和材质。

最终交付必须是可编辑 PPTX：标题、正文、表格和图片都应保持为独立对象，不能把整页内容压成一张图。`;

const sampleTable = `阶段,输入,处理,输出
内容规划,文字与表格,受众判断与论证链,DeckSpec
主题视觉,文字与用户图片,Image 2 多参考图编辑,16:9 主视觉
视觉拆解,生成图,安全区与主体区域识别,独立裁图
页面组装,DeckSpec 与视觉部件,原生对象排版,可编辑 PPTX`;

function App() {
  const [mode, setMode] = useState<Mode>("local");
  const [sourceTab, setSourceTab] = useState<SourceTab>("text");
  const [topic, setTopic] = useState("AI PPT 五阶段工作流");
  const [audience, setAudience] = useState("产品团队、创业者与内部决策者");
  const [slideCount, setSlideCount] = useState(7);
  const [textInput, setTextInput] = useState(sampleText);
  const [tableInput, setTableInput] = useState(sampleTable);
  const [imageBrief, setImageBrief] = useState("保留上传图片的主体身份；视觉需要专业、克制，并为原生文字留出干净空间。");
  const [styleId, setStyleId] = useState("product-calm");
  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [deck, setDeck] = useState<NotebookDeckSpec>(() => buildLocalDeck({
    topic: "AI PPT 五阶段工作流",
    audience: "产品团队、创业者与内部决策者",
    slideCount: 7,
    textInput: sampleText,
    tableInput: sampleTable,
    imageBrief: "专业、克制，为原生文字留出干净空间。",
    styleId: "product-calm",
    assets: [],
  }));
  const [steps, setSteps] = useState<WorkflowStep[]>(initialSteps);
  const [apiConfig, setApiConfig] = useState<ApiConfig>(loadApiConfig);
  const [apiSettingsOpen, setApiSettingsOpen] = useState(false);
  const [selectedSlide, setSelectedSlide] = useState(0);
  const [isRunning, setRunning] = useState(false);
  const [isExporting, setExporting] = useState(false);
  const [connection, setConnection] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [envKeyConfigured, setEnvKeyConfigured] = useState(false);
  const [apiCalls, setApiCalls] = useState(0);
  const [status, setStatus] = useState("本地闭环可直接运行；开启 API 模式可完成五阶段增强。");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentSlide = deck.slides[selectedSlide] || deck.slides[0];
  const currentStyle = styleProfiles.find((style) => style.id === styleId) || styleProfiles[0];
  const uploadedAssets = useMemo(() => assets.filter((asset) => asset.kind === "upload"), [assets]);
  const generatedCount = assets.filter((asset) => asset.kind === "generated").length;
  const croppedCount = assets.filter((asset) => asset.kind === "crop").length;

  useEffect(() => {
    sessionStorage.setItem("llwp-ppt-api-config", JSON.stringify(apiConfig));
  }, [apiConfig]);

  useEffect(() => {
    fetch("/api/health").then((response) => response.json()).then((data) => setEnvKeyConfigured(Boolean(data.envKeyConfigured))).catch(() => undefined);
  }, []);

  useEffect(() => {
    setSelectedSlide((index) => Math.min(index, Math.max(deck.slides.length - 1, 0)));
  }, [deck.slides.length]);

  function updateStep(id: StepId, statusValue: StepStatus, detail?: string) {
    setSteps((current) => current.map((step) => step.id === id ? { ...step, status: statusValue, detail: detail || step.detail } : step));
  }

  function resetSteps() {
    setSteps(initialSteps.map((step) => ({ ...step })));
  }

  function runLocal() {
    const next = buildLocalDeck({ topic, audience, slideCount, textInput, tableInput, imageBrief, styleId, assets });
    setDeck(next);
    setSelectedSlide(0);
    resetSteps();
    updateStep("logic", "done", "本地规则已提取观点并生成叙事骨架");
    updateStep("image", "skipped", uploadedAssets.length ? "使用用户上传图片，不调用外部生图" : "本地模式未调用图像模型");
    updateStep("decompose", "skipped", "本地模式保留原图，不做视觉拆解");
    updateStep("assemble", "done", "已组装原生标题、正文、表格与上传图片");
    updateStep("export", "idle", "点击右上角即可导出可编辑 PPTX");
    setStatus("本地 DeckSpec 已更新。内容与表格可以继续编辑后导出。");
  }

  async function runAiPipeline() {
    if (isRunning) return;
    setRunning(true);
    setApiCalls(0);
    resetSteps();
    let activeStep: StepId = "logic";
    try {
      setStatus("正在读取文字、表格和图片，并建立演示论证链…");
      updateStep("logic", "running", "模型正在区分结论、证据、缺口与行动");
      const sourceImages = await Promise.all(uploadedAssets.slice(0, 3).map(assetToApiImage));
      const response = await generateAiDeck(apiConfig, {
        topic, audience, slideCount, textInput, tableInput, imageBrief, styleId, images: sourceImages,
      });
      let nextDeck = attachEditableTable(remapUploadedImageIndexes(response.deck, uploadedAssets), tableInput);
      setDeck(nextDeck);
      setSelectedSlide(0);
      setApiCalls((value) => value + response.meta.apiCalls);
      updateStep("logic", "done", `已形成 ${nextDeck.slides.length} 页叙事，发现 ${nextDeck.story.evidenceGaps.length} 个证据缺口`);

      let nextAssets = assets.filter((asset) => asset.kind === "upload");
      if (apiConfig.imageEnabled) {
        activeStep = "image";
        updateStep("image", "running", `正在用 ${currentStyle.name} 引导 GPT Image 2`);
        setStatus("正在将内置风格图与用户内容图一起送入 Image 2…");
        const jobs = createImageJobs(nextDeck, apiConfig.imageCount);
        const imageResponse = await generateAiImages(apiConfig, jobs, sourceImages, styleId);
        const startIndex = maxAssetIndex(nextAssets) + 1;
        const generatedAssets: GeneratedAsset[] = imageResponse.images.map((image, index) => ({
          id: makeId("generated"),
          filename: `image2-slide-${image.slideIndex + 1}.png`,
          url: image.url,
          prompt: image.prompt,
          index: startIndex + index,
          kind: "generated",
          summary: `Image 2 为第 ${image.slideIndex + 1} 页生成的主视觉`,
        }));
        nextAssets = [...nextAssets, ...generatedAssets];
        nextDeck = {
          ...nextDeck,
          slides: nextDeck.slides.map((slide, index) => {
            const position = imageResponse.images.findIndex((image) => image.slideIndex === index);
            return position >= 0 ? { ...slide, imageIndex: generatedAssets[position].index } : slide;
          }),
        };
        setAssets(nextAssets);
        setDeck(nextDeck);
        setApiCalls((value) => value + imageResponse.meta.apiCalls);
        updateStep("image", "done", `生成 ${generatedAssets.length} 张 16:9 主题视觉`);

        activeStep = "decompose";
        updateStep("decompose", "running", "视觉模型正在识别文字安全区和主体区域");
        setStatus("正在拆解生成图，并裁出可单独移动的视觉部件…");
        const decompositionResponse = await decomposeAiImages(
          apiConfig,
          imageResponse.images.map((image) => ({ slideIndex: image.slideIndex, url: image.url })),
        );
        const cropResult = await createCropAssets(generatedAssets, decompositionResponse.decompositions, nextAssets);
        nextAssets = cropResult.assets;
        nextDeck = applyDecomposition(nextDeck, decompositionResponse.decompositions, cropResult.partsBySlide);
        setAssets(nextAssets);
        setDeck(nextDeck);
        setApiCalls((value) => value + decompositionResponse.meta.apiCalls);
        updateStep("decompose", "done", `已拆出 ${cropResult.cropCount} 个独立图片对象`);
      } else {
        updateStep("image", "skipped", "图片生成已关闭，保留用户上传图片");
        updateStep("decompose", "skipped", "没有生成图需要拆解");
      }

      activeStep = "assemble";
      updateStep("assemble", "running", "正在映射原生文字、表格、图片和讲稿备注");
      setStatus("正在组装可编辑页面对象…");
      await sleep(240);
      setDeck(nextDeck);
      updateStep("assemble", "done", `${nextDeck.slides.length} 页已组装，文字和表格保持原生可编辑`);

      activeStep = "export";
      updateStep("export", "running", "正在写入 PowerPoint 文件");
      setStatus("正在生成可编辑 PPTX，完成后浏览器会保存文件…");
      await exportNotebookDeck(nextDeck, nextAssets);
      updateStep("export", "done", "PPTX 已生成并保存到下载目录");
      setStatus("五阶段流程完成。你可以继续修改右侧内容并再次导出。");
    } catch (error) {
      updateStep(activeStep, "error", error instanceof Error ? error.message : "流程执行失败");
      setStatus(error instanceof Error ? error.message : "API 流程执行失败。");
    } finally {
      setRunning(false);
    }
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

  async function handleFiles(files: FileList | File[]) {
    const accepted = Array.from(files).filter((file) => file.type.startsWith("image/")).slice(0, 6 - uploadedAssets.length);
    if (!accepted.length) return;
    const startIndex = maxAssetIndex(assets) + 1;
    const additions = await Promise.all(accepted.map((file, index) => inspectImage(file, startIndex + index, imageBrief)));
    setAssets((current) => [...current.filter((asset) => asset.kind !== "generated" && asset.kind !== "crop"), ...additions]);
    setStatus(`已加入 ${additions.length} 张内容参考图。API 模式会把它们与风格引导图分开使用。`);
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark"><Layers3 size={16} /></span>
          <div><strong>LLWP PPTMAKER</strong><span>{deck.title}</span></div>
        </div>
        <div className="topbar-actions">
          <div className="mode-switch" aria-label="生成模式">
            <button className={mode === "local" ? "active" : ""} onClick={() => setMode("local")}><MonitorUp size={14} />本地</button>
            <button className={mode === "ai" ? "active" : ""} onClick={() => setMode("ai")}><Cloud size={14} />API</button>
          </div>
          <button className="icon-button" title="API 设置" aria-label="API 设置" onClick={() => setApiSettingsOpen((value) => !value)}><Settings2 size={17} /></button>
          <button className="secondary-button export-button" onClick={exportCurrentDeck} disabled={isExporting}>
            {isExporting ? <Loader2 className="spin" size={15} /> : <ArrowDownToLine size={15} />}导出 PPTX
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="source-rail">
          <div className="rail-heading">
            <div><span className="eyebrow">SOURCE</span><h1>准备素材</h1></div>
            <span className="source-count">{textInput.length + tableInput.length} 字</span>
          </div>

          <label className="field-label">演示主题</label>
          <input className="text-input title-input" value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="这份 PPT 要说明什么？" />
          <div className="inline-fields">
            <label><span>目标受众</span><input value={audience} onChange={(event) => setAudience(event.target.value)} /></label>
            <label><span>页数</span><input type="number" min={4} max={12} value={slideCount} onChange={(event) => setSlideCount(clamp(Number(event.target.value), 4, 12))} /></label>
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
                  <img src={style.image} alt={`${style.name}风格引导图`} />
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

        <section className="agent-column">
          <div className="agent-header">
            <span className="agent-orbit"><Sparkles size={16} /></span>
            <div><span className="eyebrow">TASK</span><h2>{mode === "ai" ? "AI 正在构建演示" : "本地规则工作流"}</h2></div>
          </div>
          <p className="task-summary">把文字、表格和图像整理成一份能讲清楚、能继续修改的 PowerPoint。</p>

          <div className="step-list">
            {steps.map((step, index) => <WorkflowRow key={step.id} step={step} index={index} />)}
          </div>

          <div className="run-summary">
            <span><BrainCircuit size={14} />{apiCalls} 次 API 调用</span>
            <span><ImageIcon size={14} />{generatedCount} 张生成图</span>
            <span><Crop size={14} />{croppedCount} 个裁图</span>
          </div>

          <div className="run-area">
            <p>{status}</p>
            {mode === "ai" ? (
              <button className="primary-button" onClick={runAiPipeline} disabled={isRunning}>
                {isRunning ? <Loader2 className="spin" size={16} /> : <WandSparkles size={16} />}
                {isRunning ? "正在执行五阶段…" : "运行并生成 PPTX"}
              </button>
            ) : (
              <button className="primary-button" onClick={runLocal}><Sparkles size={16} />生成本地方案</button>
            )}
            <small>{mode === "ai" ? "文字和图片会发送到你配置的模型服务。" : "不联网、不需要 Key，所有处理在浏览器完成。"}</small>
          </div>
        </section>

        <section className="artifact-pane">
          <div className="artifact-toolbar">
            <div><span className="eyebrow">ARTIFACT</span><h2>{deck.title}</h2></div>
            <div className="artifact-meta"><span>{deck.slides.length} 页</span><span>{currentStyle.name}</span><span>可编辑 PPTX</span></div>
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
        </section>
      </div>
    </main>
  );
}

function WorkflowRow({ step, index }: { step: WorkflowStep; index: number }) {
  return (
    <div className={`workflow-row ${step.status}`}>
      <div className="step-status">
        {step.status === "running" ? <Loader2 className="spin" size={15} /> : step.status === "done" ? <Check size={14} /> : step.status === "error" ? <X size={14} /> : <Circle size={11} />}
      </div>
      <div><span>0{index + 1}</span><strong>{step.title}</strong><small>{step.engine}</small><p>{step.detail}</p></div>
    </div>
  );
}

function ApiSettings({ config, onChange, envKeyConfigured, connection, onTest }: {
  config: ApiConfig;
  onChange: (value: ApiConfig) => void;
  envKeyConfigured: boolean;
  connection: "idle" | "testing" | "success" | "error";
  onTest: () => void;
}) {
  const patch = (value: Partial<ApiConfig>) => onChange({ ...config, ...value });
  return (
    <section className="api-settings">
      <div className="section-line"><div><span className="eyebrow">MODEL SERVICE</span><h2>API 设置</h2></div><KeyRound size={15} /></div>
      <label><span>文本与视觉模型服务</span><select value={config.provider} onChange={(event) => patch({ provider: event.target.value as ApiProvider, baseUrl: event.target.value === "ollama" ? "http://127.0.0.1:11434/v1" : config.baseUrl })}><option value="openai">OpenAI</option><option value="compatible">OpenAI Compatible</option><option value="ollama">Ollama</option></select></label>
      <label><span>Base URL</span><input value={config.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} /></label>
      <label><span>文本 / 视觉模型</span><input value={config.model} onChange={(event) => patch({ model: event.target.value })} placeholder="gpt-5.4-mini" /></label>
      <label><span>API Key {envKeyConfigured && <em>环境变量已配置</em>}</span><input type="password" autoComplete="off" value={config.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder={envKeyConfigured ? "使用 .env.local 中的 Key" : "sk-…"} /></label>
      <div className="api-note">页面 Key 只保存在当前浏览器会话，并由本机服务转发。长期使用请在项目根目录 <code>.env.local</code> 填写 <code>OPENAI_API_KEY=...</code>。</div>
      <label className="toggle-row"><span><strong>Image 2 生图</strong><small>需要 OpenAI 图片接口和单独计费</small></span><input type="checkbox" checked={config.imageEnabled} onChange={(event) => patch({ imageEnabled: event.target.checked })} /></label>
      {config.imageEnabled && <div className="image-config"><label className="wide"><span>图片 API Base URL</span><input value={config.imageBaseUrl || ""} onChange={(event) => patch({ imageBaseUrl: event.target.value })} /></label><label className="wide"><span>图片 API Key（留空则复用上方 Key）</span><input type="password" autoComplete="off" value={config.imageApiKey || ""} onChange={(event) => patch({ imageApiKey: event.target.value })} placeholder="可与文本服务分开" /></label><label><span>图片模型</span><input value={config.imageModel} onChange={(event) => patch({ imageModel: event.target.value })} /></label><label><span>张数</span><input type="number" min={1} max={4} value={config.imageCount} onChange={(event) => patch({ imageCount: clamp(Number(event.target.value), 1, 4) })} /></label><label><span>质量</span><select value={config.imageQuality} onChange={(event) => patch({ imageQuality: event.target.value as ApiConfig["imageQuality"] })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label></div>}
      <button className={`connection-button ${connection}`} onClick={onTest} disabled={connection === "testing"}>{connection === "testing" ? <Loader2 className="spin" size={14} /> : <Cloud size={14} />}{connection === "success" ? "连接正常" : connection === "error" ? "重试连接" : "测试连接"}</button>
    </section>
  );
}

function SlideCanvas({ slide, assets, theme, index }: { slide: NotebookSlideSpec; assets: GeneratedAsset[]; theme?: NotebookDeckSpec["theme"]; index: number }) {
  const primary = slide.imageIndex == null ? undefined : assets.find((asset) => asset.index === slide.imageIndex);
  const dark = slide.layout === "cover" || slide.layout === "section" || theme === "dark-executive";
  const parts = (slide.visualParts || []).map((part) => ({ ...part, asset: assets.find((asset) => asset.index === part.imageIndex) })).filter((part) => part.asset);
  return (
    <article className={`slide-canvas ${dark ? "dark" : "light"} layout-${slide.layout || "two-column"}`}>
      <span className="slide-number">{String(index + 1).padStart(2, "0")}</span>
      <div className="slide-copy">
        <h3>{slide.title}</h3>
        {slide.subtitle && <p className="slide-subtitle">{slide.subtitle}</p>}
        {slide.claim && <strong className="slide-claim">{slide.claim}</strong>}
        <ul>{(slide.bullets || []).slice(0, 5).map((bullet, bulletIndex) => <li key={`${bullet}-${bulletIndex}`}>{bullet}</li>)}</ul>
        {!!slide.callouts?.length && <div className="callout-row">{slide.callouts.map((callout, calloutIndex) => <span key={`${callout.label}-${calloutIndex}`}><b>{callout.value}</b><small>{callout.label}</small></span>)}</div>}
      </div>
      <div className="slide-visual">
        {parts.length ? parts.map((part) => <img key={part.imageIndex} src={part.asset!.url} alt={part.role} style={{ left: `${part.x * 100}%`, top: `${part.y * 100}%`, width: `${part.w * 100}%`, height: `${part.h * 100}%` }} />) : primary ? <img className="primary-visual" src={primary.url} alt={primary.filename} /> : slide.tableRows?.length ? <MiniTable rows={slide.tableRows} /> : <div className="visual-placeholder"><ImageIcon size={22} /><span>{slide.visualBrief || "等待视觉素材"}</span></div>}
      </div>
      {slide.safeArea && <div className="safe-area" style={{ left: `${slide.safeArea.x * 100}%`, top: `${slide.safeArea.y * 100}%`, width: `${slide.safeArea.w * 100}%`, height: `${slide.safeArea.h * 100}%` }}><span>TEXT SAFE</span></div>}
      <footer>LLWP PPTMAKER · editable objects</footer>
    </article>
  );
}

function MiniTable({ rows }: { rows: string[][] }) {
  return <table>{rows.slice(0, 6).map((row, rowIndex) => <tr key={rowIndex}>{row.slice(0, 4).map((cell, cellIndex) => rowIndex === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>)}</tr>)}</table>;
}

function SlideEditor({ slide, onChange }: { slide: NotebookSlideSpec; onChange: (patch: Partial<NotebookSlideSpec>) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="slide-editor">
      <button className="editor-toggle" onClick={() => setOpen((value) => !value)}><span><FileText size={14} />编辑当前页原生文字</span><ChevronDown className={open ? "open" : ""} size={16} /></button>
      {open && <div className="editor-fields"><label><span>观点标题</span><input value={slide.title} onChange={(event) => onChange({ title: event.target.value })} /></label><label><span>副标题</span><input value={slide.subtitle || ""} onChange={(event) => onChange({ subtitle: event.target.value })} /></label><label className="wide"><span>要点（每行一个）</span><textarea value={(slide.bullets || []).join("\n")} onChange={(event) => onChange({ bullets: event.target.value.split("\n").filter(Boolean).slice(0, 6) })} /></label><label className="wide"><span>演讲者备注</span><textarea value={slide.speakerNotes || ""} onChange={(event) => onChange({ speakerNotes: event.target.value })} /></label></div>}
    </section>
  );
}

function createImageJobs(deck: NotebookDeckSpec, count: number): ImageJob[] {
  const candidates = deck.slides.map((slide, slideIndex) => ({ slide, slideIndex })).filter(({ slide }) => Boolean(slide.imagePrompt || slide.visualBrief));
  const ordered = [...candidates.filter(({ slide }) => slide.layout === "cover"), ...candidates.filter(({ slide }) => slide.layout !== "cover")];
  return ordered.slice(0, clamp(count, 1, 4)).map(({ slide, slideIndex }) => ({
    slideIndex,
    prompt: slide.imagePrompt || slide.visualBrief || slide.title,
    layout: slide.layout || "visual-right",
  }));
}

function attachEditableTable(deck: NotebookDeckSpec, tableInput: string) {
  const rows = parseTable(tableInput);
  if (rows.length < 2) return deck;
  const target = Math.min(2, deck.slides.length - 1);
  return { ...deck, slides: deck.slides.map((slide, index) => index === target ? { ...slide, tableRows: rows.slice(0, 7).map((row) => row.slice(0, 5)) } : slide) };
}

function remapUploadedImageIndexes(deck: NotebookDeckSpec, uploads: GeneratedAsset[]) {
  return {
    ...deck,
    slides: deck.slides.map((slide) => {
      if (slide.imageIndex == null) return slide;
      const upload = uploads[slide.imageIndex - 1];
      return { ...slide, imageIndex: upload?.index };
    }),
  };
}

async function createCropAssets(generated: GeneratedAsset[], decompositions: DecompositionResult[], existing: GeneratedAsset[]) {
  const assets = [...existing];
  const partsBySlide = new Map<number, { imageIndex: number; role: string; x: number; y: number; w: number; h: number }[]>();
  let nextIndex = maxAssetIndex(assets) + 1;
  let cropCount = 0;
  for (const decomposition of decompositions) {
    const source = generated.find((asset) => asset.filename.includes(`slide-${decomposition.slideIndex + 1}.`));
    if (!source) continue;
    const usableParts = decomposition.parts.length ? decomposition.parts : [{ label: "主视觉", role: "hero", x: 0, y: 0, w: 1, h: 1 }];
    const slideParts = [];
    for (const part of usableParts) {
      const crop = await cropImage(source.url, part);
      const asset: GeneratedAsset = {
        id: makeId("crop"), filename: `slide-${decomposition.slideIndex + 1}-${part.role}-${cropCount + 1}.png`,
        url: crop.url, prompt: part.label, index: nextIndex, kind: "crop", parentId: source.id,
        width: crop.width, height: crop.height, summary: `${part.role} 独立视觉部件`,
      };
      assets.push(asset);
      slideParts.push({ imageIndex: nextIndex, role: part.role, x: part.x, y: part.y, w: part.w, h: part.h });
      nextIndex += 1;
      cropCount += 1;
    }
    partsBySlide.set(decomposition.slideIndex, slideParts);
  }
  return { assets, partsBySlide, cropCount };
}

function applyDecomposition(deck: NotebookDeckSpec, decompositions: DecompositionResult[], partsBySlide: Map<number, { imageIndex: number; role: string; x: number; y: number; w: number; h: number }[]>) {
  return {
    ...deck,
    slides: deck.slides.map((slide, index) => {
      const decomposition = decompositions.find((item) => item.slideIndex === index);
      if (!decomposition) return slide;
      const layout = index === 0 ? slide.layout : decomposition.safeArea.x < 0.5 ? "visual-right" : "visual-left";
      return { ...slide, layout, safeArea: decomposition.safeArea, visualParts: partsBySlide.get(index) || [] };
    }),
  } as NotebookDeckSpec;
}

async function assetToApiImage(asset: GeneratedAsset): Promise<ApiSourceImage> {
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

async function inspectImage(file: File, index: number, brief: string): Promise<GeneratedAsset> {
  const url = URL.createObjectURL(file);
  const image = await loadImage(url);
  const orientation = image.naturalWidth / Math.max(image.naturalHeight, 1) > 1.25 ? "横图" : image.naturalHeight > image.naturalWidth ? "竖图" : "方图";
  return { id: makeId("upload"), filename: file.name, url, prompt: brief, index, kind: "upload", width: image.naturalWidth, height: image.naturalHeight, summary: `${image.naturalWidth}×${image.naturalHeight} ${orientation}，用户内容参考` };
}

async function cropImage(url: string, rect: NormalizedRect) {
  const image = await loadImage(url);
  const sx = Math.round(clamp01(rect.x) * image.naturalWidth);
  const sy = Math.round(clamp01(rect.y) * image.naturalHeight);
  const sw = Math.max(1, Math.round(Math.min(rect.w, 1 - rect.x) * image.naturalWidth));
  const sh = Math.max(1, Math.round(Math.min(rect.h, 1 - rect.y) * image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法创建裁图画布。");
  context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  return { url: canvas.toDataURL("image/png"), width: sw, height: sh };
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取图片。"));
    image.src = url;
  });
}

function loadApiConfig(): ApiConfig {
  try {
    const stored = sessionStorage.getItem("llwp-ppt-api-config");
    return stored ? { ...defaultApiConfig, ...JSON.parse(stored) } : defaultApiConfig;
  } catch {
    return defaultApiConfig;
  }
}

function maxAssetIndex(assets: GeneratedAsset[]) { return assets.reduce((max, asset) => Math.max(max, asset.index), 0); }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.round(value) : min)); }
function clamp01(value: number) { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }
function makeId(prefix: string) { return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`; }
function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export type { NotebookDeckSpec } from "./types";
export default App;
