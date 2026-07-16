# LLWP_PPTMAKER

一个本地优先、可切换 API 增强的 AI PPT 工作台。用户可以同时输入文字、表格和图片，系统先建立演示逻辑，再生成与拆解视觉，最后输出真正可编辑的 `.pptx`。

## Manus 式首屏

首屏用一个对话框完成创建：输入主题、明确目标受众、精确指定 1–50 页，并按需选择模板，然后从模式菜单选择：

- **本地**：不联网，直接建立本地 `DeckSpec` 并输出可编辑 PPTX。
- **标准**：调用文本/视觉模型理清逻辑，保留原生文本和表格，不调用图片生成。
- **视觉增强**：运行完整五阶段流程，包括 GPT Image 2 生图与视觉拆解。

对话框左下角的 `+` 支持上传 PNG/JPG/WebP、CSV/TSV、XLSX、TXT/MD 和示例 PPTX。示例 PPTX 会提取前 40 页文字和前 4 张内嵌图片，作为内容与审美参考；旧版二进制 `.ppt`/`.xls` 需要先在 Office 中另存为 `.pptx`/`.xlsx`。

## 五阶段 API 工作流

1. **理清内容逻辑**：多模态文本模型把素材转成结构化 `DeckSpec`，包含受众判断、核心主张、叙事弧、证据缺口、逐页观点和来源。
2. **Image 2 生图**：调用 `gpt-image-2` 生成完整的高端 16:9 页面视觉底稿，而不是局部插图。OpenAI 官方接口使用多参考图；只接受单图参数的兼容网关会使用 `image` 字段。选择空白模板时不套用风格图。
3. **拆解生成图**：视觉模型分析压缩后的副本并返回文字安全区与主体裁剪框；若第三方模型超时或不支持看图，会自动切换本地 Canvas 规则，不再中断工作流。
4. **组装页面对象**：Image 2 视觉按整页底图铺设，原生标题、正文、表格、独立图片部件和演讲备注叠加组装，不把文字烘焙进图片。
5. **生成可编辑 PPTX**：PptxGenJS 输出文本框、表格、独立图片、来源和讲稿备注。

项目内置四套真实风格参考图：沉静产品、咨询网格、编辑科技、电影感数据。它们位于 `public/style-guides/`，可以继续增加或替换。

## 本地模式

不填写 API Key 也能完成：

- 中文文字拆句与观点提取
- CSV、TSV、Markdown 表格解析
- 上传图片尺寸与用途识别
- 本地 DeckSpec 和原生 PPTX 组装

本地模式不会生图和视觉拆解，但可以用上传图片跑通完整的“输入 -> 预览编辑 -> PPTX 导出”闭环。

## 运行

需要 Node.js 20 或更高版本。

```powershell
cd D:\ppt_maker
npm install
npm run dev
```

打开 <http://127.0.0.1:5173>。

```powershell
npm run build
npm start
```

## API Key

工作台右上角的“API 设置”可以配置文本服务、图片服务、模型与 Key。页面填写的 Key 只保存在当前浏览器会话。

如果 Windows 用户或计算机环境变量中已经存在 `OPENAI_API_KEY`，本地服务会自动读取，不需要把 Key 再写进页面或项目文件。程序也会读取常见代理环境变量，并在必要时沿用 Git 的 HTTP 代理设置。

第三方 OpenAI 兼容网关可设置 `OPENAI_API_BASE` 或 `OPENAI_BASE_URL`。服务会自动将页面切换为 `OpenAI Compatible`，并把该地址同时作为文本和图片接口默认值；`TEXT_API_BASE_URL`、`IMAGE_API_BASE_URL` 可以分别覆盖它。

长期使用建议在根目录创建 `.env.local`：

```dotenv
OPENAI_API_KEY=你的_key
OPENAI_API_BASE=
TEXT_API_BASE_URL=
TEXT_MODEL=gpt-5.6-terra
IMAGE_API_BASE_URL=
IMAGE_MODEL=gpt-image-2
```

`.env.local` 已被 Git 忽略，只由本地 Express 服务读取。完整说明见 [API_SETUP.md](./API_SETUP.md)。

## 验证

```powershell
npm run build
npm run test:attachments
npm run test:visual
node scripts/mock-openai.mjs
```

开发用模拟服务运行在 `http://127.0.0.1:4010/v1`，可在没有真实 API 费用的情况下验收五阶段前端流程。它不会替代正式模型质量。
