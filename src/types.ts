export type SlideLayout =
  | "cover"
  | "two-column"
  | "visual-left"
  | "visual-right"
  | "section"
  | "takeaway";

export type NormalizedRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type VisualPart = NormalizedRect & {
  imageIndex: number;
  role: string;
};

export type GeneratedAsset = {
  id: string;
  filename: string;
  url: string;
  prompt: string;
  index: number;
  kind: "upload" | "generated" | "crop";
  parentId?: string;
  width?: number;
  height?: number;
  summary?: string;
};

export type NotebookSlideSpec = {
  title: string;
  subtitle?: string;
  layout?: SlideLayout;
  claim?: string;
  bullets?: string[];
  speakerNotes?: string;
  sourceNotes?: string[];
  imageIndex?: number;
  tableRows?: string[][];
  callouts?: { label: string; value: string }[];
  visualBrief?: string;
  imagePrompt?: string;
  visualMode?: "panel" | "full-slide" | "full-slide-text";
  safeArea?: NormalizedRect;
  visualParts?: VisualPart[];
};

export type DeckStory = {
  thesis: string;
  audienceInsight: string;
  narrativeArc: string[];
  evidenceGaps: string[];
  styleId: string;
};

export type NotebookDeckSpec = {
  title: string;
  theme?: "dark-executive" | "light-consulting" | "editorial-visual";
  story: DeckStory;
  slides: NotebookSlideSpec[];
};

export type StyleProfile = {
  id: string;
  name: string;
  description: string;
  image: string;
  palette: string[];
  prompt: string;
};

export const styleProfiles: StyleProfile[] = [
  {
    id: "blank",
    name: "空白模板",
    description: "不提供风格引导，只按内容组织中性版面。",
    image: "",
    palette: ["#FBFBF8", "#191B1D", "#D8D9D4", "#6E716F"],
    prompt: "content-led neutral presentation composition with no prescribed palette or decorative style",
  },
  {
    id: "product-calm",
    name: "沉静产品",
    description: "智能工作台感，留白清楚，适合产品与方案汇报。",
    image: "/style-guides/product-calm.png",
    palette: ["#F8F8F4", "#111820", "#0E6CFF", "#B8EA3C"],
    prompt: "calm intelligent product storytelling, off-white canvas, ink structure, electric blue and chartreuse accents",
  },
  {
    id: "consulting-grid",
    name: "咨询网格",
    description: "严谨的网格与数据表达，适合商业分析和决策汇报。",
    image: "/style-guides/consulting-grid.png",
    palette: ["#FFFFFF", "#202B33", "#075CCB", "#EF2435"],
    prompt: "Swiss consulting grid, white canvas, charcoal, cobalt blue and signal red, precise data editorial design",
  },
  {
    id: "editorial-tech",
    name: "编辑科技",
    description: "强构图和杂志感，适合发布、趋势与科技主题。",
    image: "/style-guides/editorial-tech.png",
    palette: ["#0B0B0C", "#F5F5F2", "#00BFD4", "#F03B1E"],
    prompt: "contemporary technology editorial, asymmetric magazine grid, black and white, cyan and vermilion accents",
  },
  {
    id: "cinematic-dark",
    name: "电影感数据",
    description: "深色高对比与发光数据，适合路演和高层演讲。",
    image: "/style-guides/cinematic-dark.png",
    palette: ["#071017", "#1D2B35", "#12C7ED", "#D99A32"],
    prompt: "cinematic executive data storytelling, graphite black, luminous cyan signals and restrained amber highlights",
  },
];
