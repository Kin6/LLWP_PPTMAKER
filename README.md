# LLWP_PPTMAKER

一个本地优先、可切换 API 增强的 AI PPT 工作台。用户可以同时输入文字、表格和图片，系统先建立演示逻辑，再生成与拆解视觉，最后输出真正可编辑的 `.pptx`。

## 五阶段 API 工作流

1. **理清内容逻辑**：多模态文本模型把素材转成结构化 `DeckSpec`，包含受众判断、核心主张、叙事弧、证据缺口、逐页观点和来源。
2. **Image 2 生图**：调用 `gpt-image-2` 的图片编辑接口。第一张参考图来自内置风格知识库，其余参考图来自用户上传；提示词明确区分“审美参考”和“内容参考”。
3. **拆解生成图**：视觉模型返回文字安全区与 1–3 个主体裁剪框，浏览器 Canvas 将其裁成独立 PNG 部件。
4. **组装页面对象**：原生标题、正文、表格、图片部件和演讲备注按 `DeckSpec` 重新排版，不把文字烘焙进图片。
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

页面右上角齿轮可以配置文本服务、图片服务、模型与 Key。页面填写的 Key 只保存在当前浏览器会话。

长期使用建议在根目录创建 `.env.local`：

```dotenv
OPENAI_API_KEY=你的_key
TEXT_API_BASE_URL=https://api.openai.com/v1
TEXT_MODEL=gpt-5.4-mini
IMAGE_API_BASE_URL=https://api.openai.com/v1
IMAGE_MODEL=gpt-image-2
```

`.env.local` 已被 Git 忽略，只由本地 Express 服务读取。完整说明见 [API_SETUP.md](./API_SETUP.md)。

## 验证

```powershell
npm run build
node scripts/mock-openai.mjs
```

开发用模拟服务运行在 `http://127.0.0.1:4010/v1`，可在没有真实 API 费用的情况下验收五阶段前端流程。它不会替代正式模型质量。
