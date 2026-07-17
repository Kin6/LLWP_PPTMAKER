import { useRef } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Circle,
  Cloud,
  Code2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  House,
  Image as ImageIcon,
  Layers3,
  Loader2,
  MonitorUp,
  Plus,
  Presentation,
  Users,
  X,
} from "lucide-react";
import { clamp } from "../app/pipeline";
import type { ParsedAttachment } from "../lib/attachmentParser";
import { styleProfiles } from "../types";

export type GenerationPreset = "local" | "api-standard" | "api-visual" | "html-interactive";

const examplePrompts = [
  "设计带预测数据的投资者推介材料",
  "分析竞争者市场和定位",
  "研究产品发布的市场机会",
  "自动化每周团队状态报告",
];

type HomeScreenProps = {
  prompt: string;
  onPromptChange: (value: string) => void;
  preset: GenerationPreset;
  onPresetChange: (value: GenerationPreset) => void;
  presetMenuOpen: boolean;
  onTogglePreset: () => void;
  attachmentMenuOpen: boolean;
  onToggleAttachments: () => void;
  attachments: ParsedAttachment[];
  onFiles: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
  audience: string;
  onAudienceChange: (value: string) => void;
  styleId: string;
  onStyleChange: (id: string) => void;
  slideCount: number;
  onSlideCountChange: (value: number) => void;
  envKeyConfigured: boolean;
  message: string;
  running: boolean;
  onSubmit: () => void;
  onOpenWorkspace: () => void;
};

export function HomeScreen({
  prompt,
  onPromptChange,
  preset,
  onPresetChange,
  presetMenuOpen,
  onTogglePreset,
  attachmentMenuOpen,
  onToggleAttachments,
  attachments,
  onFiles,
  onRemoveAttachment,
  audience,
  onAudienceChange,
  styleId,
  onStyleChange,
  slideCount,
  onSlideCountChange,
  envKeyConfigured,
  message,
  running,
  onSubmit,
  onOpenWorkspace,
}: HomeScreenProps) {
  const imageRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLInputElement>(null);
  const pptRef = useRef<HTMLInputElement>(null);
  const documentRef = useRef<HTMLInputElement>(null);
  const presetLabel = preset === "local" ? "本地" : preset === "api-visual" ? "融合成片" : preset === "html-interactive" ? "交互网页" : "标准";

  return (
    <main className="home-shell">
      <header className="home-topbar">
        <div className="home-nav-inner">
          <div className="home-brand"><span><Layers3 size={15} /></span><strong>LLWP PPTMAKER</strong></div>
          <div className="home-nav-actions">
            <span className={`env-status ${envKeyConfigured ? "ready" : "missing"}`}>
              <Circle size={7} fill="currentColor" />{envKeyConfigured ? "系统 Key 已读取" : "未检测到系统 Key"}
            </span>
            <button className="workspace-link" onClick={onOpenWorkspace}><House size={14} />工作台</button>
          </div>
        </div>
      </header>

      <section className="home-main">
        <h1>我能为你做什么？</h1>
        <div
          className="manus-composer"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); void onFiles(event.dataTransfer.files); }}
        >
          <textarea
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void onSubmit();
            }}
            placeholder="描述主题、核心材料，以及希望受众做出的决定"
            aria-label="描述演示主题和核心材料"
          />

          {!!attachments.length && (
            <div className="attachment-chips">
              {attachments.map((attachment) => (
                <span className={`attachment-chip ${attachment.kind}`} key={attachment.id}>
                  {attachment.kind === "image" ? <ImageIcon size={13} /> : attachment.kind === "table" ? <FileSpreadsheet size={13} /> : attachment.kind === "pptx" ? <Presentation size={13} /> : <FileText size={13} />}
                  <span><strong>{attachment.name}</strong><small>{attachment.detail}</small></span>
                  <button title="移除附件" onClick={() => onRemoveAttachment(attachment.id)}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}

          <div className="composer-brief">
            <label className={!audience.trim() && message ? "needs-attention" : ""}>
              <Users size={15} />
              <span>目标受众</span>
              <input
                value={audience}
                onChange={(event) => onAudienceChange(event.target.value)}
                placeholder="例如：董事会、投资人、客户"
                aria-label="目标受众，必填"
                required
              />
            </label>
            <label>
              <Presentation size={15} />
              <span>页数</span>
              <input
                type="number"
                min={1}
                max={50}
                value={slideCount}
                onChange={(event) => onSlideCountChange(clamp(Number(event.target.value), 1, 50))}
                aria-label="精确页数，1 到 50"
              />
            </label>
          </div>

          <div className="composer-footer">
            <div className="composer-tools">
              <div className="popover-anchor">
                <button className="circle-tool" aria-label="添加附件" title="添加附件" onClick={onToggleAttachments}><Plus size={17} /></button>
                {attachmentMenuOpen && (
                  <div className="attachment-menu" role="menu">
                    <button onClick={() => imageRef.current?.click()}><ImageIcon size={16} /><span><strong>图片</strong><small>PNG、JPG、WebP</small></span></button>
                    <button onClick={() => tableRef.current?.click()}><FileSpreadsheet size={16} /><span><strong>表格</strong><small>CSV、TSV、XLSX</small></span></button>
                    <button onClick={() => pptRef.current?.click()}><Presentation size={16} /><span><strong>示例 PPTX</strong><small>提取页面文字与内嵌图片</small></span></button>
                    <button onClick={() => documentRef.current?.click()}><FileText size={16} /><span><strong>文档材料</strong><small>DOCX、文本 PDF、扫描 PDF（OCR）</small></span></button>
                  </div>
                )}
              </div>
              <span className="artifact-type"><Presentation size={14} />幻灯片</span>
              <div className="popover-anchor">
                <button className="preset-trigger" onClick={onTogglePreset}><span>{presetLabel}</span><ChevronDown size={14} /></button>
                {presetMenuOpen && (
                  <div className="preset-menu" role="menu">
                    <button className={preset === "html-interactive" ? "selected" : ""} onClick={() => onPresetChange("html-interactive")}>
                      <Code2 size={16} /><span><strong>交互网页</strong><small>可编辑 HTML + 图表动画 + 评论、微调与手绘</small></span>{preset === "html-interactive" && <Check size={15} />}
                    </button>
                    <button className={preset === "api-visual" ? "selected" : ""} onClick={() => onPresetChange("api-visual")}>
                      <ImageIcon size={16} /><span><strong>融合成片</strong><small>双轮叙事 + GPT Image 2 整页图文艺术构图</small></span>{preset === "api-visual" && <Check size={15} />}
                    </button>
                    <button className={preset === "api-standard" ? "selected" : ""} onClick={() => onPresetChange("api-standard")}>
                      <Cloud size={16} /><span><strong>标准</strong><small>只调用文本模型，生成原生分层 PPTX</small></span>{preset === "api-standard" && <Check size={15} />}
                    </button>
                    <button className={preset === "local" ? "selected" : ""} onClick={() => onPresetChange("local")}>
                      <MonitorUp size={16} /><span><strong>本地</strong><small>不调用 API，直接组装可编辑演示文稿</small></span>{preset === "local" && <Check size={15} />}
                    </button>
                  </div>
                )}
              </div>
            </div>
            <button className="composer-submit" aria-label="生成演示文稿" title="生成演示文稿" onClick={() => void onSubmit()} disabled={running}>
              {running ? <Loader2 className="spin" size={17} /> : <ArrowUp size={17} />}
            </button>
          </div>
          <input ref={imageRef} hidden type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => { if (event.target.files) void onFiles(event.target.files); event.target.value = ""; }} />
          <input ref={tableRef} hidden type="file" accept=".csv,.tsv,.xlsx,text/csv" multiple onChange={(event) => { if (event.target.files) void onFiles(event.target.files); event.target.value = ""; }} />
          <input ref={pptRef} hidden type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" onChange={(event) => { if (event.target.files) void onFiles(event.target.files); event.target.value = ""; }} />
          <input ref={documentRef} hidden type="file" accept=".docx,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf" multiple onChange={(event) => { if (event.target.files) void onFiles(event.target.files); event.target.value = ""; }} />
        </div>
        <div className="home-message" aria-live="polite">{message}</div>

        <section className="example-section">
          <h2>示例提示词</h2>
          <div className="example-grid">
            {examplePrompts.map((example) => <button key={example} onClick={() => onPromptChange(example)}>{example}<ArrowUp size={12} /></button>)}
          </div>
        </section>

        <section className="template-section">
          <div className="template-heading"><h2>选择模板（可选）</h2><span>不选风格也可以生成</span></div>
          <div className="home-template-grid">
            <button className="import-template" onClick={() => pptRef.current?.click()}><FolderOpen size={19} /><span>导入参考 PPTX</span></button>
            {styleProfiles.map((style) => (
              <button key={style.id} className={`home-template ${styleId === style.id ? "active" : ""}`} onClick={() => onStyleChange(style.id)}>
                {style.image
                  ? <img src={style.image} alt={`${style.name}模板`} />
                  : <b className="blank-template-preview" aria-hidden="true"><i /><i /><i /></b>}
                <span>{style.name}</span>
                {styleId === style.id && <i><Check size={12} /></i>}
              </button>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
