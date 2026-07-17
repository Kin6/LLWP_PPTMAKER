# API 配置与生成实现

本地模式不需要 API。标准模式只调用文本模型；融合成片模式调用文本模型与 GPT Image 2；交互网页模式在同一内容与图片流程后，再调用一次文本模型生成受约束的 `HtmlDeckSpec`。

## 请求流程

### 1. 内容策划

一次完整策划通常包含两次文本请求：

1. `DeckOutline`：只确定核心主张、受众洞察、证据顺序和严格页数的页面任务。
2. `DeckSpec`：在锁定页序后扩展标题、正文、讲稿、来源引用和图片艺术指导。

OpenAI 官方服务使用：

```text
POST /v1/responses
text.format.type = json_schema
stream = true
```

OpenAI Compatible 与 Ollama 使用：

```text
POST /v1/chat/completions
response_format.type = json_object
stream = true
```

兼容服务不接受 `response_format` 时会自动去掉该字段重试；返回内容不符合结构时，服务端会发起一次 JSON 修复请求。页数不正确时大纲和完整 Deck 都有严格重试与最终校验，不会用本地占位页掩盖错误。

模型处理用户图片时必须支持视觉输入。纯文本模型仍可规划只有文字和表格的材料。

### 2. GPT Image 2

图片按页串行请求，每页成功后立即写入当前页面内的检查点。默认页数跟随 PPT 总页数，也可在 API 设置中单独选择 1-50 页。

- 融合成片且没有参考图时使用 `POST /v1/images/generations`。
- 有用户图、风格图或使用原生分层时使用 `POST /v1/images/edits`。
- OpenAI 官方接口可用 `image[]` 发送多张参考图。
- 只接受单图的兼容网关会改用 `image` 字段。
- 返回图片 URL 时，服务端会下载并转换为 data URL。
- 浏览器最终把图片按 cover 规则整理为 1536 x 864，裁切只发生在可延展背景边缘。

每个页面任务包含总主张、受众、叙事弧、当前页内容、前后页标题和统一视觉连续性，用提示词降低逐页生成互不相关海报的概率。当前第三阶段只核对已生成页数并执行 16:9 归一化，不声称运行了尚未实现的风格识别器。

### 3. HTML 交互演示

HTML 模式使用独立无文字主视觉，再将 `NotebookDeckSpec` 与安全初稿提交给布局模型。模型只能返回满足 JSON Schema 的 `HtmlDeckSpec`；Schema 不合格、模型超时或兼容接口异常时，系统保留本地安全编排器生成的草稿，第三阶段不会因为单次设计请求失败而丢失前两步结果。

局部 AI 修改只返回白名单 Patch，不能修改图片/视频 URL、注入脚本或写入原型链字段。

## 只允许系统环境变量配置

### 页面设置

工作台右上角的“API 设置”只保留非敏感的生成参数：

- 成片模式：整页图文融合或原生分层。
- 生图页数、质量、单页等待时间和自动重试次数。
- 图片生成开关和连接测试。

这些非敏感参数保存在当前标签页的 `sessionStorage`。页面没有 Key、Base URL 或模型输入框。

### 系统环境变量

Windows 示例：

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "your_key", "User")
[Environment]::SetEnvironmentVariable("OPENAI_API_BASE", "https://api.openai.com/v1", "User")
[Environment]::SetEnvironmentVariable("TEXT_MODEL", "gpt-5.6-terra", "User")
[Environment]::SetEnvironmentVariable("IMAGE_MODEL", "gpt-image-2", "User")
```

Linux/macOS 示例：

```bash
export OPENAI_API_KEY="your_key"
export OPENAI_API_BASE="https://api.openai.com/v1"
export TEXT_MODEL="gpt-5.6-terra"
export IMAGE_MODEL="gpt-image-2"
npm run dev
```

配置优先级：

1. `TEXT_API_BASE_URL` / `IMAGE_API_BASE_URL` 等具体系统环境变量。
2. `OPENAI_API_BASE` 或 `OPENAI_BASE_URL` 通用兼容地址。
3. OpenAI 官方默认地址。

服务先读取当前进程环境变量；Windows 上还会尝试读取用户和计算机级变量。首屏只显示是否已检测到 Key，不会把 Key 或服务配置返回到前端。项目不会读取 `.env` 或 `.env.local`。

### 代理与备用线路

服务读取 `HTTPS_PROXY`、`HTTP_PROXY` 和 `ALL_PROXY`；这些变量为空时会尝试沿用当前仓库的 `git config http.proxy`。

图片请求默认最长等待 600 秒，遇到超时、429、5xx 或 Cloudflare 524 时重试 1 次。可以使用以下变量调整：

```dotenv
IMAGE_API_TIMEOUT_MS=600000
IMAGE_API_MAX_RETRIES=1
OPENAI_API_FALLBACK_BASE=
IMAGE_API_FALLBACK_BASE_URL=
```

主地址为 `api.chatanywhere.org` 时，未显式设置备用地址也会尝试 `api.chatanywhere.tech`。

## 附件输入

- 图片：PNG、JPG、WebP；最多取前 3 张压缩后送入文本模型，图片接口最多接收 4 张参考图。
- 表格：CSV、TSV、XLSX；XLSX 在浏览器内读取第一个工作表。
- 文本：TXT、MD。
- DOCX：标题层级、段落、表格、内嵌图片和章节路径。
- PDF：最多前 80 页；原生文字不足的页面按需 OCR，并记录置信度。
- PPTX：前 40 页文字与前 4 张内嵌图片。

旧版 `.ppt` 和 `.xls` 不直接解析，需要先转换为新版 Office 格式。

## 数据与隐私边界

- 本地模式不会请求外部模型。
- API 模式会把文字、表格、压缩图片和所需生成结果发送到用户配置的模型服务。
- 系统环境 Key 不会被接口返回给前端，客户端提交的 Key、Base URL、模型和 Provider 会被服务端忽略。
- 浏览器端 OCR 使用 Tesseract，不调用云端 OCR 服务；首次运行可能下载语言数据。
- HTML 运行时位于 sandbox iframe，不能读取主应用的会话配置和 API Key。
- 内置风格图会随图片请求发送，不应放入客户隐私或专有内容。

## 调用量与成本

以 N 页融合成片为例，正常路径通常为：

```text
2 次文本请求（大纲 + 完整 DeckSpec）
+ N 次图片请求
= N + 2 次 API 调用
```

HTML 模式通常再增加 1 次布局请求，即 `N + 3` 次。页数纠错、兼容接口回退、JSON 修复和图片重试都会增加调用数。标准模式关闭图片后通常只需要 2 次文本请求。

## 本地模拟服务

```bash
node scripts/mock-openai.mjs
```

默认地址为 `http://127.0.0.1:4010/v1`。模拟服务覆盖流式输出、严格页数、逐页图片、一次性失败重试和 HTML 布局，不代表正式模型的视觉质量。
