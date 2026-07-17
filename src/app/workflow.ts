export type StepId = "logic" | "image" | "decompose" | "assemble" | "export";
export type StepStatus = "idle" | "running" | "done" | "skipped" | "error";

export type WorkflowStep = {
  id: StepId;
  title: string;
  engine: string;
  status: StepStatus;
  detail: string;
};

export type WorkflowActivity = {
  id: string;
  stepId: StepId;
  message: string;
  detail: string;
  status: "running" | "done";
};

export const stepOrder: StepId[] = ["logic", "image", "decompose", "assemble", "export"];

export const initialSteps: WorkflowStep[] = [
  { id: "logic", title: "策划整套叙事", engine: "双轮 Story Planner", status: "idle", detail: "建立主张、证据链、页间因果和收束动作" },
  { id: "image", title: "生成主题视觉", engine: "GPT Image 2 · 参考图编辑", status: "idle", detail: "用户内容图 + 可选风格引导图" },
  { id: "decompose", title: "校验成片一致性", engine: "页序 / 风格 / 画幅", status: "idle", detail: "检查页数、叙事承接、视觉语言和 16:9 画幅" },
  { id: "assemble", title: "组装整页成片", engine: "Image 2 + PPTX", status: "idle", detail: "优先保留完整图文构图和连续视觉节奏" },
  { id: "export", title: "生成演示 PPTX", engine: "PptxGenJS", status: "idle", detail: "输出完整成片、内容源与讲稿备注" },
];

export const htmlInitialSteps: WorkflowStep[] = [
  { id: "logic", title: "策划演示叙事", engine: "双轮 Story Planner", status: "idle", detail: "建立主张、证据链和跨页顺序" },
  { id: "image", title: "生成视觉素材", engine: "GPT Image 2", status: "idle", detail: "为 HTML 场景生成无文字主视觉" },
  { id: "decompose", title: "编排 HTML 场景", engine: "HtmlDeckSpec", status: "idle", detail: "映射文字、图表、图形、素材和图层" },
  { id: "assemble", title: "初始化交互编辑器", engine: "Reveal + ECharts", status: "idle", detail: "装载动画、选择桥接、评论和微调变量" },
  { id: "export", title: "准备交互交付", engine: "Standalone HTML", status: "idle", detail: "可导出离线 HTML 或静态 PPTX" },
];

export function shouldRunFrom(start: StepId, target: StepId) {
  return stepOrder.indexOf(target) >= stepOrder.indexOf(start);
}

export function stepTitle(step: StepId) {
  return initialSteps.find((item) => item.id === step)?.title || "失败环节";
}
