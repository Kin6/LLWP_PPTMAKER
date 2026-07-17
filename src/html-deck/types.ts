import type { SourceLocation } from "../types";

export type HtmlNodeType = "text" | "shape" | "image" | "chart" | "video" | "widget";

export type HtmlRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type HtmlNodeBase = HtmlRect & {
  id: string;
  type: HtmlNodeType;
  name: string;
  zIndex: number;
  locked?: boolean;
  hidden?: boolean;
  animation?: "none" | "fade" | "rise" | "scale" | "draw";
  animationDelay?: number;
};

export type HtmlTextStyle = {
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  color: string;
  align: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  radius?: number;
  opacity?: number;
  padding?: number;
};

export type HtmlTextNode = HtmlNodeBase & {
  type: "text";
  text: string;
  role: "title" | "subtitle" | "body" | "caption" | "metric" | "source";
  style: HtmlTextStyle;
};

export type HtmlShapeNode = HtmlNodeBase & {
  type: "shape";
  shape: "rect" | "circle" | "line";
  fill: string;
  stroke: string;
  strokeWidth: number;
  radius?: number;
  opacity?: number;
};

export type HtmlImageNode = HtmlNodeBase & {
  type: "image";
  src: string;
  alt: string;
  objectFit: "cover" | "contain";
  prompt?: string;
  assetId?: string;
  opacity?: number;
};

export type HtmlChartSeries = {
  name: string;
  values: number[];
  color?: string;
};

export type HtmlChartNode = HtmlNodeBase & {
  type: "chart";
  chartType: "bar" | "line" | "pie" | "scatter" | "radar";
  labels: string[];
  series: HtmlChartSeries[];
  showLegend: boolean;
  showValues: boolean;
  accentColor: string;
};

export type HtmlVideoNode = HtmlNodeBase & {
  type: "video";
  src: string;
  poster?: string;
  autoplay: boolean;
  loop: boolean;
  muted: boolean;
};

export type HtmlWidgetNode = HtmlNodeBase & {
  type: "widget";
  widgetType: "counter" | "progress" | "particle-field" | "timeline";
  props: Record<string, string | number | boolean>;
};

export type HtmlNode = HtmlTextNode | HtmlShapeNode | HtmlImageNode | HtmlChartNode | HtmlVideoNode | HtmlWidgetNode;

export type HtmlInteraction = {
  id: string;
  trigger: "click" | "hover" | "enter" | "key";
  action: "next" | "previous" | "toggle" | "highlight" | "set-variable" | "animate";
  sourceId?: string;
  targetId?: string;
  variableId?: string;
  value?: string | number | boolean;
};

export type HtmlSlideSpec = {
  id: string;
  title: string;
  background: string;
  transition: "none" | "fade" | "slide" | "zoom";
  nodes: HtmlNode[];
  interactions: HtmlInteraction[];
  speakerNotes: string;
  sourceRefs?: SourceLocation[];
};

export type HtmlTweakVariable = {
  id: string;
  label: string;
  type: "number" | "color" | "boolean" | "select";
  value: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
};

export type HtmlDeckComment = {
  id: string;
  slideId: string;
  nodeId?: string;
  text: string;
  createdAt: string;
  resolved: boolean;
};

export type HtmlDeckDrawing = {
  id: string;
  slideId: string;
  color: string;
  width: number;
  points: { x: number; y: number }[];
};

export type HtmlDeckSpec = {
  id: string;
  title: string;
  width: number;
  height: number;
  revision: number;
  theme: {
    name: string;
    background: string;
    surface: string;
    text: string;
    muted: string;
    primary: string;
    accent: string;
    fontFamily: string;
  };
  slides: HtmlSlideSpec[];
  variables: HtmlTweakVariable[];
  comments: HtmlDeckComment[];
  drawings: HtmlDeckDrawing[];
};

export type HtmlDeckPatch = {
  slideId: string;
  nodeId?: string;
  operation: "update-node" | "add-node" | "remove-node" | "update-slide" | "reorder-slides";
  changes: Record<string, unknown>;
};

export type HtmlDeckGenerationMeta = {
  apiCalls: number;
  model?: string;
  provider?: string;
  refinementApplied?: boolean;
};
