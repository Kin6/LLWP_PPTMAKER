# LLWP PPTMAKER

LLWP PPTMAKER 是一个本地优先、可选 AI 增强的中文演示文稿工作台。它能把文字、表格、图片、DOCX、PDF 和示例 PPTX 整理为有明确叙事顺序的演示，并输出可编辑 PPTX 或可交互的单文件 HTML。

项目当前重点不是让模型一次性吐出不可控的页面代码，而是把内容规划、视觉生成、结构校验、编辑和导出拆成可检查、可恢复的流水线。

## 能做什么

- 精确生成 1-50 页演示，不用占位页补数量。
- 先生成轻量叙事大纲，再扩展完整 `DeckSpec`，减少第一步等待和重复内容。
- 直接请求 GPT Image 2，并将返回结果归一化为 1536 x 864 的 16:9 画布。
- 按页生成并保存检查点，图片或后续阶段失败后可从断点继续。
- 以 Manus/Codex 式任务轨迹逐步显示当前阶段、流式内容和 API 调用数。
- 导入 DOCX、PDF、扫描 PDF、XLSX、CSV/TSV、TXT/MD、图片和 PPTX 参考材料。
- 把页码、章节、表格、图片与 OCR 置信度保存在结构化来源引用中。
- 输出原生分层 PPTX、整页图文融合 PPTX，或可编辑、可交互的 HTML Deck。

## 四种创建模式

| 模式 | 模型调用 | 主要输出 | 适合场景 |
| --- | --- | --- | --- |
| 本地 | 无 | 原生可编辑 PPTX | 快速整理文字、表格和已有图片 |
| 标准 | 文本模型 | 原生分层 PPTX | 需要更好的叙事，但不需要 AI 生图 |
| 融合成片 | 文本模型 + GPT Image 2 | 高完成度 PPTX | 优先追求完整视觉和跨页一致性 |
| 交互网页 | 文本模型 + GPT Image 2 + HTML 布局 | 可编辑 HTML、离线 HTML、静态 PPTX | 需要动画、图表、交互和设计工作台 |

融合成片默认把标题、证据、标注和主视觉一起交给 Image 2 编排，视觉完整度更高，但页面文字属于整页图片。API 设置中可以切换到“原生分层”，让文字、表格和基础形状保持 PowerPoint 原生可编辑。

## 生成流程

### PPTX 模式

1. **策划整套叙事**：第一次文本请求只生成严格页数的 `DeckOutline`，确定总主张、证据顺序和每页任务；第二次请求根据大纲生成完整 `DeckSpec`。
2. **生成主题视觉**：GPT Image 2 按页处理。每个请求都包含整套主张、目标受众、前后页关系和当前页信息，默认生图页数跟随演示总页数。
3. **确认成片结构**：核对已生成页数并统一整理为 16:9 画布；跨页承接与视觉连续性由大纲和逐页提示词约束，不把提示词约束冒充成视觉检测结果。
4. **组装整页成片**：融合模式铺满整张画布；原生分层模式保留文字、表格、形状与独立主视觉。
5. **生成 PPTX**：PptxGenJS 写出页面、讲稿备注和内容源。

### 交互网页模式

```text
用户材料
  -> DeckOutline
  -> NotebookDeckSpec
  -> GPT Image 2 逐页主视觉
  -> HtmlDeckSpec 草稿
  -> AI 布局规划与 Schema 校验
  -> Reveal.js + ECharts 工作台
  -> 离线 HTML / 静态 PPTX
```

模型不会获得任意脚本执行权限。它只返回受 JSON Schema 和 Zod 约束的 `HtmlDeckSpec`，局部修改也只能提交白名单 Patch。运行时位于无同源权限的 sandbox iframe 中。

工作台当前支持：

- 页面缩略图切换、复制和删除。
- 元素选择、拖拽、缩放、图层与属性编辑。
- 撤销/重做、评论与解决状态、Tweaks、手绘标注。
- 对当前页或选中元素执行 AI 局部修改。
- Reveal.js 放映、ECharts 图表以及 `click`、`hover`、`enter`、`key` 触发器。
- `next`、`previous`、`toggle`、`highlight`、`set-variable`、`animate` 动作。
- IndexedDB 自动保存；素材会转换为可恢复的数据 URI。
- 导出内联依赖和素材的单文件 HTML，以及静态可编辑 PPTX。

HTML 动画、视频状态和 Web 交互无法无损转换到 PowerPoint，静态 PPTX 会按明确规则降级。详见 [HTML 交互演示模式](./docs/HTML_INTERACTIVE_MODE.md)。

## 支持的材料

| 类型 | 当前处理方式 |
| --- | --- |
| PNG/JPG/WebP | 作为内容图片和视觉参考图 |
| CSV/TSV/XLSX | 提取表格；XLSX 当前读取第一个工作表 |
| TXT/MD | 作为主题材料和结构化文字 |
| DOCX | 提取标题层级、段落、表格、内嵌图片和章节路径 |
| 文本型 PDF | 最多解析前 80 页，按页提取文字、对齐明确的表格和可读取图片 |
| 扫描 PDF | 原生文字不足时按需使用浏览器端 Tesseract OCR，并标记置信度 |
| PPTX | 提取前 40 页文字和前 4 张内嵌图片，作为内容与风格参考 |

旧版二进制 `.ppt` 和 `.xls` 暂不直接解析，请先在 Office 或 LibreOffice 中另存为 `.pptx` 和 `.xlsx`。

每段材料都会获得稳定 `blockId`。页码、DOCX 章节路径、段落/表格/图片序号、提取方式和 OCR 置信度会进入 `sourceRefs` 与 `sourceNotes`；模型只能引用真实存在的证据块，低置信度 OCR 不会被当作确定事实。

## 快速开始

需要 Node.js 20 或更高版本。

```bash
git clone https://github.com/Kin6/LLWP_PPTMAKER.git
cd LLWP_PPTMAKER
npm ci
npm run dev
```

打开 <http://127.0.0.1:5173>。

生产构建：

```bash
npm run build
npm start
```

服务默认只监听 `127.0.0.1`。可以通过 `HOST` 和 `PORT` 修改监听地址和端口。

## API 配置

本地模式不需要 API Key。其他模式只从运行服务的本机系统环境变量读取 Key、Base URL 和模型。浏览器不会显示、保存或提交这些字段，服务端也会忽略客户端伪造的配置。

Windows 用户环境变量示例：

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "your_key", "User")
[Environment]::SetEnvironmentVariable("OPENAI_API_BASE", "https://api.openai.com/v1", "User")
[Environment]::SetEnvironmentVariable("TEXT_MODEL", "gpt-5.6-terra", "User")
[Environment]::SetEnvironmentVariable("IMAGE_MODEL", "gpt-image-2", "User")
```

- Linux/macOS 请在启动服务的登录环境中 `export` 同名变量。
- `OPENAI_API_BASE` 或 `OPENAI_BASE_URL` 可设置 OpenAI 兼容网关。
- `TEXT_API_BASE_URL` 和 `IMAGE_API_BASE_URL` 可以让文本与图片使用不同服务。
- `OPENAI_API_FALLBACK_BASE` 和 `IMAGE_API_FALLBACK_BASE_URL` 可以设置图片备用线路。
- `IMAGE_API_TIMEOUT_MS` 和 `IMAGE_API_MAX_RETRIES` 可以设置服务端默认等待与重试。
- 官方 OpenAI 文本路径使用 Responses API；兼容服务使用 Chat Completions，并带结构修复回退。
- 单页图片默认等待 10 分钟，临时错误默认重试 1 次。
- 主线路为 `api.chatanywhere.org` 时，重试可以自动切换到 `api.chatanywhere.tech`。
- 服务会读取 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY`，必要时沿用 Git 的 HTTP 代理。

项目不会读取 `.env` 或 `.env.local`。修改系统环境变量后需要重启服务。完整说明见 [API 配置](./API_SETUP.md)。

## 测试

```bash
npm run build
npm run test:attachments
npm run test:provenance
npm run test:integrated-export
npm run test:image-geometry
npm run test:image-prompt
npm run test:html-deck
npm run test:visual
```

本地模拟 OpenAI 服务：

```bash
node scripts/mock-openai.mjs
```

模拟服务默认运行在 `http://127.0.0.1:4010/v1`，可验证流式文本、逐页图片、失败重试、HTML Deck 和断点续跑，不会产生真实 API 费用。

## 已知边界

- 融合成片的文字已经压入整页图片，修改内容后需要重新生成该页。
- HTML 与 PPTX 的动画、视频、交互和字体排版不是无损双向转换。
- HTML 模式不包含组织级多人实时协作、Figma/Canva 连接器或任意用户代码执行。
- 浏览器刷新会清除当前 PPTX 流水线的内存检查点；已完成的 HTML Deck 会保存在 IndexedDB。
- OCR 首次运行需要下载中英文语言数据，识别质量取决于扫描清晰度。

## 进一步阅读

- [HTML 交互演示模式](./docs/HTML_INTERACTIVE_MODE.md)
- [协作者复刻指南](./docs/COLLABORATOR_REPRODUCTION.md)
- [可编辑 PPTX 技术路线](./docs/EDITABLE_PIPELINE.md)
- [API 配置与实现](./API_SETUP.md)
- [产品原则](./PRODUCT.md)
- [设计系统](./DESIGN.md)

版本变化见 [CHANGELOG.md](./CHANGELOG.md)。
