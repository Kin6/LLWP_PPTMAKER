# 协作者复刻指南

这份文档用于让新的开发合作者在另一台 Windows、macOS 或 Linux 机器上复刻当前项目的运行、验证和 API 工作流。它描述的是当前仓库的可运行实现，不承诺不同模型或网关生成像素级一致的图片。

## 复刻边界

能够复刻的是：输入方式、内容规划结构、跨页叙事约束、图片提示词策略、PPTX 输出方式、断点续跑逻辑与验收测试。

不能要求绝对一致的是：Image 2 等生成模型的具体画面、第三方网关延迟和模型版本行为。每次生图都具有随机性；复刻验收应检查页面数、叙事、信息层级、画幅、可编辑性和错误恢复，而不是逐像素比较。

## 先决条件

- Node.js 20 或更高版本。
- Git。
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
```

`test:image-prompt` 会临时启动模拟 OpenAI 服务和应用，验证高信息密度提示词仍包含 3–5 个证据点、跨页连续性、安全区和“无整页外框”约束；不会调用真实 API，也不会产生费用。

## 真实 API 配置

复制环境模板：

```powershell
Copy-Item .env.example .env.local
```

编辑 `.env.local`，示例：

```dotenv
OPENAI_API_KEY=your_key
OPENAI_API_BASE=https://api.chatanywhere.org/v1
OPENAI_API_FALLBACK_BASE=https://api.chatanywhere.tech/v1
TEXT_MODEL=gpt-5.6-terra
IMAGE_MODEL=gpt-image-2
IMAGE_API_TIMEOUT_MS=600000
IMAGE_API_MAX_RETRIES=1
```

重启 `npm run dev` 后访问 `http://127.0.0.1:5173/api/health`。返回结果应显示 `envKeyConfigured: true`、所选 Base URL、图片备用网关、模型和超时配置。不要把 `.env.local` 提交到 Git。

也可通过页面右上角“API 设置”填写 Key 与 Base URL。页面配置只保存于该标签页的 `sessionStorage`；环境变量由服务端读取，Key 不返回给浏览器。字段优先级为：页面填写值 > `TEXT_API_BASE_URL` / `IMAGE_API_BASE_URL` > `OPENAI_API_BASE` > OpenAI 官方默认地址。

更详细的接口、隐私与第三方网关说明见 [API_SETUP.md](../API_SETUP.md)。

## 三种运行模式

| 模式 | 外部调用 | 输出特点 | 复刻验收 |
| --- | --- | --- | --- |
| 本地 | 无 | 原生文字、表格、上传图片都可编辑 | 输入到 PPTX 导出闭环 |
| 标准 | 文本模型 | 模型整理内容逻辑，PPTX 保持原生对象 | 严格页数、标题因果、内容可编辑 |
| 视觉增强 | 文本模型 + 图片模型 | 默认整页图文融合，视觉上限较高 | 每页图、跨页衔接、断点续跑、PPTX 导出 |

整页图文融合模式的文字是图片的一部分，不能在 PowerPoint 逐字编辑。需要逐字编辑时，选择“原生分层”；该模式让图片模型只生成视觉资产，文字与表格由 PptxGenJS 输出为原生对象。

## 当前架构与代码职责

```text
用户文字 / 表格 / 图片 / 示例 PPTX
        │
        ├── 浏览器附件解析：src/lib/attachmentParser.ts
        ├── 本地内容规划：src/lib/localPlanner.ts
        └── API 内容规划：POST /api/ai/generate-deck
                              │
                         DeckSpec（论证与逐页内容）
                              │
              ┌───────────────┴────────────────┐
              │                                │
       原生分层                        整页图文融合
              │                                │
       视觉资产生图                     每页完整 Image 2 成片
              │                                │
              └───────────────┬────────────────┘
                              │
                   src/lib/exportDeck.ts
                              │
                          可下载 PPTX
```

关键文件：

- [src/App.tsx](../src/App.tsx)：首屏、模式切换、五阶段状态、检查点和断点续跑。
- [server/index.mjs](../server/index.mjs)：API 路由、环境变量、网关回退、DeckSpec 提示词、Image 2 高信息密度提示词。
- [src/lib/localPlanner.ts](../src/lib/localPlanner.ts)：离线 DeckSpec 规则。
- [src/lib/attachmentParser.ts](../src/lib/attachmentParser.ts)：图片、CSV/TSV/XLSX、TXT/MD、PPTX 附件解析。
- [src/lib/exportDeck.ts](../src/lib/exportDeck.ts)：PptxGenJS 导出；融合页作为整页图，原生分层页保留文字与表格对象。
- [src/lib/imageGeometry.ts](../src/lib/imageGeometry.ts)：将常见 3:2 生图安全地放入 16:9 幻灯片。
- [scripts/mock-openai.mjs](../scripts/mock-openai.mjs)：本地无费用的兼容 API 模拟服务。

## 生成质量约束

视觉增强模式的核心不是“按段落切页”，而是先建立可连读的标题论证链。正文页要求：结论标题、核心解释、3–5 个相互不重复的证据点，以及 1–3 组关键数据或标注。图片提示词还要求：

- 背景、主视觉、文字与数据处于同一连续全画布，不能生成投影幕、白纸、整页相框或框中框。
- 页面内部允许少量证据模块、流程节点、数据或局部特写，但必须依附同一主场景与网格。
- 相邻页共享主体、环境、色彩、字体气质和视觉母题；下一页必须承接本页新增的信息。
- 内容不足时优先保留标题、核心句、三个重点、关键数字和页码，禁止虚构数据或生成 `DeckSpec`、`API`、`Prompt` 等制作过程文字。

这组约束位于 `server/index.mjs` 的 `buildDeckPrompt`、`buildDeckRefinementPrompt`、`buildIntegratedTextImagePrompt` 和 `buildIntegratedArtDirection`。修改其中一项后必须运行 `npm run test:image-prompt`。

## 真实联调步骤

1. 用 3 页、小量文字、明确受众做第一次测试。
2. 选择“视觉增强”，选择“整页图文融合”，图片页数选择“跟随 PPT 总页数”。
3. 确认任务轨迹依次完成：内容逻辑、主题视觉、视觉校验、页面组装、PPTX 导出。
4. 检查每页是否有一个结论标题、至少三个不同证据点、完整的 16:9 画面和可连读的标题链。
5. 关闭图片生成后再跑一次，确认“标准”模式能输出可编辑文字和表格。
6. 故意使用一个不可用图片地址或临时关掉网关，确认失败步骤显示“从此处继续”，且已成功页面不会再次请求。

## 故障排查

| 现象 | 优先检查 |
| --- | --- |
| `Incorrect API key` | Key 与 Base URL 是否属于同一服务；修改系统环境变量后是否重新启动服务进程。 |
| 看到 HTML / 524 | 这是网关返回的超时页面，不是图片 JSON；检查图片 Base URL、等待时间与备用网关。 |
| 只生成部分页面 | 检查“生图页数”是否小于 PPT 总页数，或从失败页继续；断点续跑保留已完成页。 |
| 页面文字太少 | 查看内容输入是否足够，确认使用最新 `test:image-prompt` 通过的版本，并选择整页图文融合。 |
| 出现 `[object Object]` | 检查表格/图片摘要是否在显示前转为字符串；使用附件解析测试定位。 |
| PPTX 图片被裁切 | 检查 `imageGeometry.ts` 测试；有效文字和主体必须留在提示词安全区内。 |

## 合作约定

提交前至少运行受改动影响的测试；修改提示词必须运行 `test:image-prompt`，修改导出必须运行 `test:integrated-export`，修改 3:2 到 16:9 的逻辑必须运行 `test:image-geometry`。不要提交 `.env.local`、真实 API Key、下载的 PPTX 或 `artifacts/`。

本仓库目前未包含 `LICENSE` 文件。技术上可以让受邀协作者复刻，但若要允许公开分发、商业使用或外部贡献，仓库所有者还需要明确选择并添加许可证；这属于项目授权决策，不应由合作者自行假定。
