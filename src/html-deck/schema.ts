import { z } from "zod";

const sourceLocationSchema = z.object({
  blockId: z.string().max(120),
  attachmentId: z.string().max(120),
  filename: z.string().max(220),
  kind: z.enum(["docx", "pdf", "pptx", "xlsx", "text", "image"]),
  extraction: z.enum(["native", "ocr"]),
  page: z.number().int().positive().optional(),
  sectionPath: z.array(z.string().max(180)).max(9).optional(),
  paragraphIndex: z.number().int().positive().optional(),
  tableIndex: z.number().int().positive().optional(),
  imageIndex: z.number().int().positive().optional(),
  confidence: z.number().min(0).max(100).optional(),
  lowConfidence: z.boolean().optional(),
});

const rectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().positive().max(1),
  h: z.number().positive().max(1),
});

const baseSchema = rectSchema.extend({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  zIndex: z.number().int().min(0).max(1000),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  animation: z.enum(["none", "fade", "rise", "scale", "draw"]).optional(),
  animationDelay: z.number().min(0).max(30).optional(),
});

const textNodeSchema = baseSchema.extend({
  type: z.literal("text"),
  text: z.string().max(4_000),
  role: z.enum(["title", "subtitle", "body", "caption", "metric", "source"]),
  style: z.object({
    fontSize: z.number().min(8).max(160),
    fontWeight: z.number().min(100).max(900),
    lineHeight: z.number().min(0.8).max(3),
    color: z.string().max(80),
    align: z.enum(["left", "center", "right"]),
    verticalAlign: z.enum(["top", "middle", "bottom"]),
    backgroundColor: z.string().max(80).optional(),
    borderColor: z.string().max(80).optional(),
    borderWidth: z.number().min(0).max(20).optional(),
    radius: z.number().min(0).max(100).optional(),
    opacity: z.number().min(0).max(1).optional(),
    padding: z.number().min(0).max(100).optional(),
  }),
});

const shapeNodeSchema = baseSchema.extend({
  type: z.literal("shape"),
  shape: z.enum(["rect", "circle", "line"]),
  fill: z.string().max(80),
  stroke: z.string().max(80),
  strokeWidth: z.number().min(0).max(20),
  radius: z.number().min(0).max(100).optional(),
  opacity: z.number().min(0).max(1).optional(),
});

const imageNodeSchema = baseSchema.extend({
  type: z.literal("image"),
  src: z.string().max(8_000_000),
  alt: z.string().max(300),
  objectFit: z.enum(["cover", "contain"]),
  prompt: z.string().max(2_000).optional(),
  assetId: z.string().max(160).optional(),
  opacity: z.number().min(0).max(1).optional(),
});

const chartNodeSchema = baseSchema.extend({
  type: z.literal("chart"),
  chartType: z.enum(["bar", "line", "pie", "scatter", "radar"]),
  labels: z.array(z.string().max(120)).max(50),
  series: z.array(z.object({
    name: z.string().max(120),
    values: z.array(z.number()).max(50),
    color: z.string().max(80).optional(),
  })).max(12),
  showLegend: z.boolean(),
  showValues: z.boolean(),
  accentColor: z.string().max(80),
});

const videoNodeSchema = baseSchema.extend({
  type: z.literal("video"),
  src: z.string().max(2_000),
  poster: z.string().max(2_000).optional(),
  autoplay: z.boolean(),
  loop: z.boolean(),
  muted: z.boolean(),
});

const widgetNodeSchema = baseSchema.extend({
  type: z.literal("widget"),
  widgetType: z.enum(["counter", "progress", "particle-field", "timeline"]),
  props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export const htmlNodeSchema = z.discriminatedUnion("type", [
  textNodeSchema,
  shapeNodeSchema,
  imageNodeSchema,
  chartNodeSchema,
  videoNodeSchema,
  widgetNodeSchema,
]);

const interactionSchema = z.object({
  id: z.string().min(1).max(120),
  trigger: z.enum(["click", "hover", "enter", "key"]),
  action: z.enum(["next", "previous", "toggle", "highlight", "set-variable", "animate"]),
  sourceId: z.string().max(120).optional(),
  targetId: z.string().max(120).optional(),
  variableId: z.string().max(120).optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const htmlDeckSchema = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(240),
  width: z.number().int().min(640).max(3840),
  height: z.number().int().min(360).max(2160),
  revision: z.number().int().min(1),
  theme: z.object({
    name: z.string().min(1).max(120),
    background: z.string().max(80),
    surface: z.string().max(80),
    text: z.string().max(80),
    muted: z.string().max(80),
    primary: z.string().max(80),
    accent: z.string().max(80),
    fontFamily: z.string().max(240),
  }),
  slides: z.array(z.object({
    id: z.string().min(1).max(120),
    title: z.string().min(1).max(240),
    background: z.string().max(160),
    transition: z.enum(["none", "fade", "slide", "zoom"]),
    nodes: z.array(htmlNodeSchema).max(120),
    interactions: z.array(interactionSchema).max(120),
    speakerNotes: z.string().max(8_000),
    sourceRefs: z.array(sourceLocationSchema).max(8).optional(),
  })).min(1).max(50),
  variables: z.array(z.object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(160),
    type: z.enum(["number", "color", "boolean", "select"]),
    value: z.union([z.string(), z.number(), z.boolean()]),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    options: z.array(z.string().max(120)).max(30).optional(),
  })).max(80),
  comments: z.array(z.object({
    id: z.string().min(1).max(120),
    slideId: z.string().min(1).max(120),
    nodeId: z.string().max(120).optional(),
    text: z.string().max(2_000),
    createdAt: z.string().max(80),
    resolved: z.boolean(),
  })).max(500),
  drawings: z.array(z.object({
    id: z.string().min(1).max(120),
    slideId: z.string().min(1).max(120),
    color: z.string().max(80),
    width: z.number().min(1).max(24),
    points: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).min(2).max(4_000),
  })).max(500),
});

export function parseHtmlDeck(value: unknown) {
  return htmlDeckSchema.parse(value);
}
