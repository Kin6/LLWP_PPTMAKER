import { useEffect, useState } from "react";
import { Check, ChevronDown, Circle, Cloud, FileText, Image as ImageIcon, Loader2, RotateCcw, ShieldCheck, X } from "lucide-react";
import { clamp } from "../app/pipeline";
import type { WorkflowActivity, WorkflowStep } from "../app/workflow";
import type { ApiConfig } from "../lib/apiClient";
import type { GeneratedAsset, NotebookDeckSpec, NotebookSlideSpec } from "../types";

export function WorkflowRow({ step, index, activities, onRetry, retrying }: {
  step: WorkflowStep;
  index: number;
  activities: WorkflowActivity[];
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (step.status === "running" || step.status === "error") setExpanded(true);
  }, [step.status]);
  return (
    <article className={`workflow-row ${step.status}`}>
      <div className="step-status">
        {step.status === "running" ? <Loader2 className="spin" size={15} /> : step.status === "done" ? <Check size={14} /> : step.status === "error" ? <X size={14} /> : <Circle size={11} />}
      </div>
      <div className="workflow-content">
        <button className="workflow-heading" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          <span>0{index + 1}</span><strong>{step.title}</strong><ChevronDown className={expanded ? "open" : ""} size={14} />
        </button>
        {expanded && <div className="workflow-details">
          <small>{step.engine}</small>
          {!!activities.length && <div className="activity-thread">
            {activities.map((activity) => (
              <div className={`activity-entry ${activity.status}`} key={activity.id}>
                <span>{activity.status === "running" ? <Loader2 className="spin" size={11} /> : <Check size={10} />}</span>
                <div><strong>{activity.message}</strong><small>{activity.detail}</small></div>
              </div>
            ))}
          </div>}
          <p>{step.detail}</p>
        </div>}
        {onRetry && <button className="step-retry" onClick={onRetry} disabled={retrying}>{retrying ? <Loader2 className="spin" size={12} /> : <RotateCcw size={12} />}从此处继续</button>}
      </div>
    </article>
  );
}

export function ApiSettings({ config, onChange, envKeyConfigured, textBackend, imageGenerationAvailable, connection, onTest }: {
  config: ApiConfig;
  onChange: (value: ApiConfig) => void;
  envKeyConfigured: boolean;
  textBackend: "http" | "codex-cli";
  imageGenerationAvailable: boolean;
  connection: "idle" | "testing" | "success" | "error";
  onTest: () => void;
}) {
  const patch = (value: Partial<ApiConfig>) => onChange({ ...config, ...value });
  return (
    <section className="api-settings">
      <div className="section-line"><div><span className="eyebrow">SYSTEM ENVIRONMENT</span><h2>API 设置</h2></div><ShieldCheck size={15} /></div>
      <div className="api-note"><strong>{textBackend === "codex-cli" ? "已选择本机 Codex CLI" : envKeyConfigured ? "已检测到系统 API Key" : "文本模型未配置"}</strong><br />{textBackend === "codex-cli"
        ? "文本生成复用当前终端的 Codex 登录状态，网站不再要求单独填写 Key。"
        : <>密钥、服务地址和模型只从本机系统环境变量读取，不会显示、保存或由浏览器提交。请配置 <code>OPENAI_API_KEY</code>、<code>OPENAI_API_BASE</code> 和 <code>TEXT_MODEL</code> 后重启服务。</>}
        {!imageGenerationAvailable && <><br />当前未配置图片生成服务，交互网页会使用 HTML/CSS 视觉完成页面。</>}</div>
      <label className="toggle-row"><span><strong>Image 2 视觉生成</strong><small>{imageGenerationAvailable ? "生成整页图或独立主视觉，按页面计费" : "未配置图片服务"}</small></span><input type="checkbox" disabled={!imageGenerationAvailable} checked={config.imageEnabled && imageGenerationAvailable} onChange={(event) => patch({ imageEnabled: event.target.checked })} /></label>
      {config.imageEnabled && imageGenerationAvailable && <div className="image-config"><label className="wide"><span>成片模式</span><select value={config.imageTextMode} onChange={(event) => patch({ imageTextMode: event.target.value as ApiConfig["imageTextMode"] })}><option value="integrated">整页图文融合（推荐成片）</option><option value="native">原生分层（编辑优先）</option></select><small className="field-hint">整页融合让文字直接参与画面构图；原生分层便于编辑，但文字与图片的视觉融合度会降低。</small></label><label><span>生图页数</span><select value={config.imageCount} onChange={(event) => patch({ imageCount: clamp(Number(event.target.value), 0, 50) })}><option value={0}>跟随 PPT 总页数</option>{Array.from({ length: 50 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count} 页</option>)}</select></label><label><span>质量</span><select value={config.imageQuality} onChange={(event) => patch({ imageQuality: event.target.value as ApiConfig["imageQuality"] })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><label><span>单页最长等待</span><select value={config.imageTimeoutSeconds} onChange={(event) => patch({ imageTimeoutSeconds: clamp(Number(event.target.value), 240, 900) })}><option value={240}>4 分钟</option><option value={360}>6 分钟</option><option value={600}>10 分钟（推荐）</option><option value={900}>15 分钟</option></select></label><label><span>超时自动重试</span><select value={config.imageMaxRetries} onChange={(event) => patch({ imageMaxRetries: clamp(Number(event.target.value), 0, 2) })}><option value={0}>不重试</option><option value={1}>重试 1 次（推荐）</option><option value={2}>重试 2 次</option></select></label><small className="field-hint wide">第三方网关可能早于本地上限中止请求；自动重试耗尽后仍可从失败页继续。</small></div>}
      <button className={`connection-button ${connection}`} onClick={onTest} disabled={connection === "testing"}>{connection === "testing" ? <Loader2 className="spin" size={14} /> : <Cloud size={14} />}{connection === "success" ? "连接正常" : connection === "error" ? "重试连接" : "测试连接"}</button>
    </section>
  );
}

export function SlideCanvas({ slide, assets, theme, index }: { slide: NotebookSlideSpec; assets: GeneratedAsset[]; theme?: NotebookDeckSpec["theme"]; index: number }) {
  const primary = slide.imageIndex == null ? undefined : assets.find((asset) => asset.index === slide.imageIndex);
  const dark = slide.layout === "cover" || slide.layout === "section" || theme === "dark-executive";
  const parts = (slide.visualParts || []).map((part) => ({ ...part, asset: assets.find((asset) => asset.index === part.imageIndex) })).filter((part) => part.asset);
  const integratedText = Boolean(primary && slide.visualMode === "full-slide-text");
  const fullSlide = Boolean(primary && (slide.visualMode === "full-slide" || integratedText));
  const copyStyle = fullSlide && !integratedText && slide.safeArea ? {
    left: `${slide.safeArea.x * 100}%`,
    top: `${slide.safeArea.y * 100}%`,
    width: `${slide.safeArea.w * 100}%`,
    maxHeight: `${slide.safeArea.h * 100}%`,
  } : undefined;
  const tableStyle = fullSlide && slide.safeArea ? {
    left: `${slide.safeArea.x < 0.5 ? 53 : 5}%`,
    top: "22%",
    width: "42%",
    height: "58%",
  } : undefined;
  return (
    <article className={`slide-canvas ${dark ? "dark" : "light"} layout-${slide.layout || "two-column"} ${fullSlide ? "full-slide-art" : ""}`}>
      {fullSlide && <img className="slide-background-visual" src={primary!.url} alt={primary!.filename} />}
      {!integratedText && <span className="slide-number">{String(index + 1).padStart(2, "0")}</span>}
      {!integratedText && <div className="slide-copy" style={copyStyle}>
        <h3>{slide.title}</h3>
        {slide.subtitle && <p className="slide-subtitle">{slide.subtitle}</p>}
        {slide.claim && <strong className="slide-claim">{slide.claim}</strong>}
        <ul>{(slide.bullets || []).slice(0, fullSlide ? 4 : 5).map((bullet, bulletIndex) => <li key={`${bullet}-${bulletIndex}`}>{bullet}</li>)}</ul>
        {!!slide.callouts?.length && <div className="callout-row">{slide.callouts.map((callout, calloutIndex) => <span key={`${callout.label}-${calloutIndex}`}><b>{callout.value}</b><small>{callout.label}</small></span>)}</div>}
      </div>}
      {!fullSlide && <div className="slide-visual">
        {parts.length ? parts.map((part) => <img key={part.imageIndex} src={part.asset!.url} alt={part.role} style={{ left: `${part.x * 100}%`, top: `${part.y * 100}%`, width: `${part.w * 100}%`, height: `${part.h * 100}%` }} />) : primary ? <img className="primary-visual" src={primary.url} alt={primary.filename} /> : slide.tableRows?.length ? <MiniTable rows={slide.tableRows} /> : <div className="visual-placeholder"><ImageIcon size={22} /><span>{slide.visualBrief || "等待视觉素材"}</span></div>}
      </div>}
      {fullSlide && !integratedText && slide.tableRows?.length && <div className="full-slide-table" style={tableStyle}><MiniTable rows={slide.tableRows} /></div>}
      {!fullSlide && slide.safeArea && <div className="safe-area" style={{ left: `${slide.safeArea.x * 100}%`, top: `${slide.safeArea.y * 100}%`, width: `${slide.safeArea.w * 100}%`, height: `${slide.safeArea.h * 100}%` }}><span>TEXT SAFE</span></div>}
      {!integratedText && <footer>LLWP PPTMAKER · editable objects</footer>}
    </article>
  );
}

function MiniTable({ rows }: { rows: string[][] }) {
  return <table>{rows.slice(0, 6).map((row, rowIndex) => <tr key={rowIndex}>{row.slice(0, 4).map((cell, cellIndex) => rowIndex === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>)}</tr>)}</table>;
}

export function SlideEditor({ slide, onChange }: { slide: NotebookSlideSpec; onChange: (patch: Partial<NotebookSlideSpec>) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="slide-editor">
      <button className="editor-toggle" onClick={() => setOpen((value) => !value)}><span><FileText size={14} />{slide.visualMode === "full-slide-text" ? "编辑当前页内容源（重新生成后更新画面）" : "编辑当前页原生文字"}</span><ChevronDown className={open ? "open" : ""} size={16} /></button>
      {open && <div className="editor-fields"><label><span>观点标题</span><input value={slide.title} onChange={(event) => onChange({ title: event.target.value })} /></label><label><span>副标题</span><input value={slide.subtitle || ""} onChange={(event) => onChange({ subtitle: event.target.value })} /></label><label className="wide"><span>要点（每行一个）</span><textarea value={(slide.bullets || []).join("\n")} onChange={(event) => onChange({ bullets: event.target.value.split("\n").filter(Boolean).slice(0, 6) })} /></label><label className="wide"><span>演讲者备注</span><textarea value={slide.speakerNotes || ""} onChange={(event) => onChange({ speakerNotes: event.target.value })} /></label></div>}
    </section>
  );
}
