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
2. **Image 2 生图**：调用 `gpt-image-2` 生成视觉。生图页数默认严格跟随 PPT 总页数，也可单独指定 1–50 页；每个任务都携带整套主张、叙事弧、上一页和下一页，保持跨页连续。OpenAI 官方接口使用多参考图；只接受单图参数的兼容网关会使用 `image` 字段。选择空白模板时不套用风格图。
3. **验证视觉对象**：不再把矩形截图描述成“真正拆解”。原生可拆版把 Image 2 输出作为独立主视觉对象；图文融合整页图明确保留为单张画面。
4. **组装页面对象**：支持两种交付方式。`原生可拆版` 使用独立图片、原生文字框、表格和形状；`图文融合整页图` 让 Image 2 把文字与视觉设计成同一张完整页面，视觉更强但画面文字不可逐字编辑。
5. **生成可编辑 PPTX**：PptxGenJS 输出 PPTX、独立裁图、来源和讲稿备注。图文融合页面中的画面文字属于整页图片，修改内容源后需要重新生成；原生文字模式中的文本框和表格可以逐字编辑。

项目内置四套真实风格参考图：沉静产品、咨询网格、编辑科技、电影感数据。它们位于 `public/style-guides/`，可以继续增加或替换。

真正可编辑的 SVG → DrawingML 升级路线和开源方案比较见 [docs/EDITABLE_PIPELINE.md](./docs/EDITABLE_PIPELINE.md)。

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
