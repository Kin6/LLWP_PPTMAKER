# 协作者复刻指南

这份文档用于让新的开发合作者在另一台 Windows、macOS 或 Linux 机器上复刻当前项目的运行、验证和 API 工作流。它描述的是当前仓库的可运行实现，不承诺不同模型或网关生成像素级一致的图片。

## 复刻边界

能够复刻的是：输入方式、内容规划结构、跨页叙事约束、图片提示词策略、PPTX 输出方式、断点续跑逻辑与验收测试。

不能要求绝对一致的是：Image 2 等生成模型的具体画面、第三方网关延迟和模型版本行为。每次生图都具有随机性；复刻验收应检查页面数、叙事、信息层级、画幅、可编辑性和错误恢复，而不是逐像素比较。

## 先决条件

- Node.js 20 或更高版本。
- Git。
- HTML 模式的 QA 和端到端测试需要 Playwright Chromium。
- 可选：一个支持 OpenAI 兼容接口的文本模型；若要运行视觉增强模式，还需要支持 `gpt-image-2` 图像接口的服务。
- 不需要 Python、Office 或本地数据库。

检查 Node 版本：

```powershell
node --version
```

## 从零启动

```powershell
git clone https://github.com/Kin6/LLWP_PPTMAKER.git
cd LLWP_PPTMAKER
npm ci
npx playwright install chromium
npm run dev
```

浏览器打开 <http://127.0.0.1:5173>。开发模式同时启动 Express API 与 Vite 前端中间件。

生产式本地运行：

```powershell
npm run build
npm start
```

如果 5173 被占用，可改用：

```powershell
node server/index.mjs --port 5180
```

## 无 API 的可重复验收

先用“本地”模式输入一段文本、一个 CSV/TSV 表格和一张图片，确认可以编辑预览并导出 PPTX。此模式不离开本机，适合先验证浏览器、附件解析和 PptxGenJS 输出。

再运行自动化检查：

```powershell
npm run build
npm run test:attachments
npm run test:visual
npm run test:image-geometry
npm run test:image-prompt
npm run test:integrated-export
npm run test:provenance
npm run test:html-deck
```

`test:image-prompt` 会临时启动模拟 OpenAI 服务和应用，验证高信息密度提示词仍包含 3–5 个证据点、跨页连续性、安全区和“无整页外框”约束；不会调用真实 API，也不会产生费用。

## 真实 API 配置

为避免 API Key 进入浏览器、页面会话、网络请求或项目文件，本项目只接受运行服务机器上的系统环境变量配置。页面不会提供 Key、Base URL 或模型输入框，服务端也会忽略客户端提交的这些字段。

Windows 用户环境变量示例：

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "your_key", "User")
[Environment]::SetEnvironmentVariable("OPENAI_API_BASE", "https://api.chatanywhere.org/v1", "User")
[Environment]::SetEnvironmentVariable("OPENAI_API_FALLBACK_BASE", "https://api.chatanywhere.tech/v1", "User")
[Environment]::SetEnvironmentVariable("TEXT_MODEL", "gpt-5.6-terra", "User")
[Environment]::SetEnvironmentVariable("IMAGE_MODEL", "gpt-image-2", "User")
```

关闭并重新打开终端，再启动 `npm run dev`。访问 `http://127.0.0.1:5173/api/health`，应返回 `envKeyConfigured: true` 和图片超时/重试默认值，但不会返回 Key、服务地址或模型。

`TEXT_API_BASE_URL` 与 `IMAGE_API_BASE_URL` 可以分别覆盖 `OPENAI_API_BASE`；`IMAGE_API_TIMEOUT_MS` 与 `IMAGE_API_MAX_RETRIES` 控制服务端默认值。项目不读取 `.env` 或 `.env.local`，不要在项目目录、浏览器、截图或版本库中保存 Key。

更详细的接口、隐私与第三方网关说明见 [API_SETUP.md](../API_SETUP.md)。

## HTML Job 存储与部署

开发环境默认把 HTML Job 写入仓库根目录下被忽略的 `.deck-jobs/`。生产环境必须通过 `DECK_JOB_ROOT` 指向独立持久卷；否则进程或容器重建后，URL 中的 `?job=<jobId>` 无法恢复历史任务。

默认硬限额如下，超限写入会在原子替换前失败：

| 项目 | 限额 |
| --- | ---: |
| 单个 Job 工作区 | 512 MiB |
| Markdown 文件 | 2 MiB |
| 单页 HTML | 200 KiB |
| 单页 CSS | 120 KiB |
| JSON 文件 | 10 MiB |
| 单张图片 | 12 MiB |
| standalone HTML | 256 MiB |
| 页面数 / 上传图片数 | 50 |

服务不会自动清理终态 Job。运维应根据业务保留期备份或删除终态目录，并在删除前确认该 Job 没有 active worker；不得直接删除 active Job。Node worker 的 512 MiB old generation、64 MiB young generation 和 8 MiB stack 限制不约束 Chromium。生产环境还必须对 worker 与 Chromium 的整个进程树显式设置 CPU、RSS、进程数、磁盘和网络限制。

## 四种运行模式

| 模式 | 外部调用 | 输出特点 | 复刻验收 |
| --- | --- | --- | --- |
| 本地 | 无 | 原生文字、表格、上传图片都可编辑 | 输入到 PPTX 导出闭环 |
| 标准 | 文本模型 | 模型整理内容逻辑，PPTX 保持原生对象 | 严格页数、标题因果、内容可编辑 |
| 视觉增强 | 文本模型 + 图片模型 | 默认整页图文融合，视觉上限较高 | 每页图、跨页衔接、断点续跑、PPTX 导出 |
| 交互网页 | 文本模型，可选图片模型 | Agent 生成、图表、动画与离线交互 | 大纲预览、恢复、revision、QA、离线 HTML |

整页图文融合模式的文字是图片的一部分，不能在 PowerPoint 逐字编辑。需要逐字编辑时，选择“原生分层”；该模式让图片模型只生成视觉资产，文字与表格由 PptxGenJS 输出为原生对象。

## 当前架构与代码职责

```text
用户文字 / 表格 / 图片 / DOCX / PDF / 示例 PPTX
        │
        ├── 浏览器附件解析：src/lib/attachmentParser.ts
        ├── PPTX：DeckOutline -> DeckSpec -> PptxGenJS
        │
        └── HTML Job
              -> sourceBlocks
              -> slides-content.md
              -> design / calibration
              -> HTML/CSS/assets
              -> browser QA / repair
              -> revisioned standalone HTML
```

关键文件：

- [src/App.tsx](../src/App.tsx)：模式切换、附件提交和 HTML Job 入口。
- [src/app/pipeline.ts](../src/app/pipeline.ts)：共享的图片任务、画幅归一化、检查点数据与 API 参数。
- [src/components/HomeScreen.tsx](../src/components/HomeScreen.tsx)：Manus 式首屏与附件入口。
- [src/components/WorkspacePanels.tsx](../src/components/WorkspacePanels.tsx)：任务轨迹、API 状态和 PPTX 编辑面板。
- [src/deck-agent-ui/](../src/deck-agent-ui/)：HTML Agent 时间线、只读产物预览、sandbox preview 和 revision 操作。
- [server/deck-agent/](../server/deck-agent/)：Job、事件、工具、分阶段编排、页面策略、QA、revisions 和 worker 生命周期。
- [skills/generate-html-deck/](../skills/generate-html-deck/)：阶段路由、内容密度、设计方向、布局目录、视觉 rubric、来源与安全约束。
- [server/index.mjs](../server/index.mjs)：API 挂载、环境配置以及 PPTX 模式仍使用的模型与图片入口。
- [src/lib/localPlanner.ts](../src/lib/localPlanner.ts)：离线 DeckSpec 规则。
- [src/lib/attachmentParser.ts](../src/lib/attachmentParser.ts)：图片、表格、TXT/MD、DOCX、PDF/OCR 和 PPTX 附件解析。
- [src/lib/exportDeck.ts](../src/lib/exportDeck.ts)：PptxGenJS 导出；融合页作为整页图，原生分层页保留文字与表格对象。
- [src/lib/imageGeometry.ts](../src/lib/imageGeometry.ts)：将常见 3:2 生图安全地放入 16:9 幻灯片。
- [scripts/mock-openai.mjs](../scripts/mock-openai.mjs)：本地无费用的兼容 API 模拟服务。

## 生成质量约束

视觉增强模式的核心不是“按段落切页”，而是先建立可连读的标题论证链。正文页要求：结论标题、核心解释、3–5 个相互不重复的证据点，以及 1–3 组关键数据或标注。图片提示词还要求：

- 背景、主视觉、文字与数据处于同一连续全画布，不能生成投影幕、白纸、整页相框或框中框。
- 页面内部允许少量证据模块、流程节点、数据或局部特写，但必须依附同一主场景与网格。
- 相邻页共享主体、环境、色彩、字体气质和视觉母题；下一页必须承接本页新增的信息。
- 内容不足时优先保留标题、核心句、三个重点、关键数字和页码，禁止虚构数据或生成 `DeckSpec`、`API`、`Prompt` 等制作过程文字。

这组约束位于 `server/index.mjs` 的 `buildDeckOutlinePrompt`、`buildDeckFromOutlinePrompt`、`buildIntegratedTextImagePrompt` 和 `buildIntegratedArtDirection`。修改其中一项后必须运行 `npm run test:image-prompt` 与 `npm run test:html-deck`。

## 真实联调步骤

1. 用 3 页、小量文字、明确受众做第一次测试。
2. 选择“视觉增强”，选择“整页图文融合”，图片页数选择“跟随 PPT 总页数”。
3. 确认任务轨迹依次完成：内容逻辑、主题视觉、视觉校验、页面组装、PPTX 导出。
4. 检查每页是否有一个结论标题、至少三个不同证据点、完整的 16:9 画面和可连读的标题链。
5. 关闭图片生成后再跑一次，确认“标准”模式能输出可编辑文字和表格。
6. 故意使用一个不可用图片地址或临时关掉网关，确认失败步骤显示“从此处继续”，且已成功页面不会再次请求。
7. 选择“交互网页”，确认 Markdown 大纲生成后自动继续、步骤可折叠、预览页数严格一致，并能 revision、撤销和导出离线 HTML。

## 故障排查

| 现象 | 优先检查 |
| --- | --- |
| `Incorrect API key` | Key 与 Base URL 是否属于同一服务；修改系统环境变量后是否重新启动服务进程。 |
| 看到 HTML / 524 | 这是网关返回的超时页面，不是图片 JSON；检查图片 Base URL、等待时间与备用网关。 |
| 只生成部分页面 | 检查“生图页数”是否小于 PPT 总页数，或从失败页继续；断点续跑保留已完成页。 |
| 页面文字太少 | 查看内容输入是否足够，确认使用最新 `test:image-prompt` 通过的版本，并选择整页图文融合。 |
| 出现 `[object Object]` | 检查表格/图片摘要是否在显示前转为字符串；使用附件解析测试定位。 |
| PPTX 图片被裁切 | 检查 `imageGeometry.ts` 测试；有效文字和主体必须留在提示词安全区内。 |
| HTML Job 刷新后为空 | 确认 URL 保留 `?job=`，`DECK_JOB_ROOT` 可写且未被临时清理。 |
| HTML 状态为 `needs-review` | 已发布版本可预览；自动修复预算已用尽，应先人工检查，再选择重试或提交定向 revision。 |
| Chromium 启动失败 | 运行 `npx playwright install chromium`，并检查容器的共享内存、进程数、CPU/RSS 和 sandbox 限制。 |

## 合作约定

提交前至少运行受改动影响的测试；修改提示词必须运行 `test:image-prompt`，修改导出必须运行 `test:integrated-export`，修改 3:2 到 16:9 的逻辑必须运行 `test:image-geometry`，修改 HTML Agent 必须运行 `test:html-deck`。不要提交 `.env.local`、真实 API Key、下载文件、`.deck-jobs/` 或 `artifacts/`。

本仓库目前未包含 `LICENSE` 文件。技术上可以让受邀协作者复刻，但若要允许公开分发、商业使用或外部贡献，仓库所有者还需要明确选择并添加许可证；这属于项目授权决策，不应由合作者自行假定。
