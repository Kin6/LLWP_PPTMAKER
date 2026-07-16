# LLWP_PPTMAKER

一个本地优先、可切换 API 增强的 AI PPT 工作台。用户可以同时输入文字、表格和图片，系统先建立演示逻辑，再生成与拆解视觉，最后输出真正可编辑的 `.pptx`。

## Manus 式首屏

首屏用一个对话框完成创建：输入主题、明确目标受众、精确指定 1–50 页，并按需选择模板，然后从模式菜单选择：

- **本地**：不联网，直接建立本地 `DeckSpec` 并输出可编辑 PPTX。
- **标准**：调用文本/视觉模型理清逻辑，保留原生文本和表格，不调用图片生成。
- **视觉增强**：运行完整五阶段流程，包括 GPT Image 2 生图与视觉拆解。

对话框左下角的 `+` 支持上传 PNG/JPG/WebP、CSV/TSV、XLSX、TXT/MD 和示例 PPTX。示例 PPTX 会提取前 40 页文字和前 4 张内嵌图片，作为内容与审美参考；旧版二进制 `.ppt`/`.xls` 需要先在 Office 中另存为 `.pptx`/`.xlsx`。

## 五阶段 API 工作流

1. **策划整套叙事**：文本模型先建立严格页数的 `DeckSpec`，再进行第二轮总编辑审校，专门检查页间因果、删除重复观点、压缩可见文案并强化每页视觉导演意图。
2. **Image 2 生图**：调用 `gpt-image-2` 生成视觉。生图页数默认严格跟随 PPT 总页数，也可单独指定 1–50 页；每个任务都携带整套主张、叙事弧、上一页和下一页，保持跨页连续。OpenAI 官方接口使用多参考图；只接受单图参数的兼容网关会使用 `image` 字段。选择空白模板时不套用风格图。
3. **校验成片一致性**：检查严格页数、16:9 画幅、跨页叙事承接和统一视觉语言，不再把矩形截图描述成“真正拆解”。
4. **组装整页成片**：默认使用 `整页图文融合`，让 Image 2 把文字、主体、光影、轨迹和信息层级设计成同一张完整页面。`原生分层` 保留为编辑优先的备选模式。
5. **生成 PPTX**：PptxGenJS 输出 PPTX、内容源和讲稿备注。默认融合页面中的文字属于整页图片，修改内容源后需要重新生成；原生分层模式中的文本框和表格可以逐字编辑。

API 流程支持当前页面内的断点续跑。内容策划完成后会保存 DeckSpec，Image 2 改为逐页请求并在每页成功后立即保存检查点；某一页超时或某个后续环节失败时，可以从该环节继续，不会重复已经成功的文本规划和生图调用。刷新或关闭页面会清除这份临时检查点。

单页生图默认最长等待 10 分钟。第三方兼容网关返回超时、限流或临时服务错误时默认自动重试 1 次；主线路为 `api.chatanywhere.org` 时，重试会自动切换到 `api.chatanywhere.tech`。等待时间与重试次数可在页面 API 设置中调整，也可通过 `IMAGE_API_TIMEOUT_MS`、`IMAGE_API_MAX_RETRIES` 设置服务端默认值。

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
OPENAI_API_BASE=https://api.chatanywhere.org/v1
OPENAI_API_FALLBACK_BASE=https://api.chatanywhere.tech/v1
TEXT_API_BASE_URL=
TEXT_MODEL=gpt-5.6-terra
IMAGE_API_BASE_URL=
IMAGE_API_FALLBACK_BASE_URL=
IMAGE_MODEL=gpt-image-2
IMAGE_API_TIMEOUT_MS=600000
IMAGE_API_MAX_RETRIES=1
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
