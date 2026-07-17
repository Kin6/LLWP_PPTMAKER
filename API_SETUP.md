# API 配置与五阶段实现

本地模式不需要 API。首屏“标准”运行内容规划与原生组装，“视觉增强”运行完整五阶段，并把状态与错误显示在工作台的任务轨迹中。

## 需要哪些 API

### A. 文本与视觉模型

同一个多模态模型承担当前流程的内容策划，并为后续视觉拆解接口预留能力：

- **阶段 1，内容逻辑**：读取文字、表格、图片及图片说明，返回严格 JSON `DeckSpec`。
- **视觉拆解接口（预留）**：读取 Image 2 生成图，返回归一化文字安全区和主体裁剪框；当前浏览器流程不会把整页融合图伪装成“可拆卸对象”。整页融合模式只校验页数、画幅和视觉连续性；原生分层模式直接保留独立图片与原生文字对象。

接口：

- OpenAI：`POST /v1/responses`
- OpenAI Compatible：`POST /v1/chat/completions`
- Ollama：OpenAI 兼容地址，例如 `http://127.0.0.1:11434/v1`

模型必须支持看图，才能同时使用用户图片和完成视觉拆解。纯文本本地模型只能完成不含图片的内容规划，阶段 3 会失败并在界面中明确提示。

### B. GPT Image 2

阶段 2 调用 `POST /v1/images/edits`，默认模型为 `gpt-image-2`，不是简单的文字生图：

1. 服务端读取用户选择的 `public/style-guides/*.png`，作为第一张参考图。
2. 用户上传图作为后续参考图。
3. 提示词要求只从第一张图学习视觉语法，从用户图保持内容身份。
4. `整页图文融合` 会要求模型逐字呈现已规划的标题、解释、证据点和数据标注，并与主视觉组成一张完整幻灯片；`原生分层` 则禁止模型生成文字、字母、数字、Logo 和水印，只生成可单独放入 PPTX 的视觉资产。

OpenAI 官方接口使用 `image[]` 传递多张参考图。ChatAnywhere 等文档声明单图 `image` 参数的兼容网关会自动切换为单图模式：上传了用户图片时优先发送第一张用户图片，并把风格方向写进提示词；没有用户图片时发送内置风格图。提示词统一以“画一个……”开头。第三方返回图片 URL 时，服务端会先下载并转换为 data URL，再进入视觉拆解和 PPTX 导出。

内容模型与图片模型可以使用不同 Base URL 和 Key。例如：本地 Ollama 负责内容，OpenAI 负责 Image 2。

## Key 填在哪里

### 方式 1：页面设置

点击右上角齿轮：

- `文本与视觉模型服务`：OpenAI、Compatible 或 Ollama
- `Base URL`：内容模型地址
- `文本 / 视觉模型`：需支持结构化 JSON，处理图片时还需支持视觉输入
- `API Key`：内容模型 Key
- `图片 API Base URL`：通常为 `https://api.openai.com/v1`
- `图片 API Key`：可与内容模型分开；留空则复用内容 Key
- `图片模型`：默认 `gpt-image-2`
- `单页最长等待`：默认 10 分钟，可选 4、6、10 或 15 分钟
- `超时自动重试`：默认重试 1 次；重试仍失败时可从当前页继续

这些字段保存在当前标签页的 `sessionStorage`。关闭浏览器会话后清除，前端构建文件中不会写入 Key。

### 方式 2：`.env.local`

在 `D:\ppt_maker\.env.local` 中填写：

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

修改后重启：

```powershell
npm run dev
```

### 方式 3：Windows 系统环境变量

已设置 `OPENAI_API_KEY` 时无需创建 `.env.local`。服务启动时按“当前进程 -> Windows 用户环境变量 -> Windows 计算机环境变量”的顺序读取：

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "你的_key", "User")
```

设置后重新打开终端并运行 `npm run dev`。首屏只显示“系统 Key 已读取”，Key 本身不会返回前端。若使用 OpenAI 兼容服务，还需要在“API 设置”中填写该服务的正确 Base URL；OpenAI Key 不能自动推断第三方服务地址。

第三方教程常用的 `OPENAI_API_BASE` 和 `OPENAI_BASE_URL` 也会被读取，并自动同步到所有浏览器页面：

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_BASE", "https://api.chatanywhere.org/v1", "User")
```

`TEXT_API_BASE_URL` 和 `IMAGE_API_BASE_URL` 的优先级更高，适合文本与图片使用不同服务的情况。

当主线路是 `api.chatanywhere.org` 时，图片请求遇到 524、超时、限流或临时服务错误，会在自动重试时切换到 `api.chatanywhere.tech`。也可以使用 `OPENAI_API_FALLBACK_BASE` 或 `IMAGE_API_FALLBACK_BASE_URL` 明确指定备用地址。

服务会读取 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY`，并在这些变量缺失时尝试沿用当前仓库的 `git config http.proxy`，用于访问外部模型服务。

## 附件输入

- 图片：PNG、JPG、WebP，作为内容参考图发送给支持视觉的模型。
- 表格：CSV、TSV、XLSX；XLSX 在浏览器内按 Office Open XML 解析，不上传原文件。
- 示例 PPT：PPTX；提取前 40 页文本和前 4 张内嵌图片，合并进内容规划与风格参考。
- 文本：TXT、MD，追加到主题文字。
- 旧版 `.ppt`、`.xls` 不直接解析，请先另存为新版 Office 格式。

## 数据与隐私边界

- 本地模式不会请求外部模型。
- API 模式会发送文字、表格、压缩后的用户图片和生成图到所配置的模型服务。
- 用户原始图片不会写入项目目录；浏览器仅在当前页面会话中持有对象 URL。
- 内置风格图会随 Image 2 请求发送，它们只承担审美方向，不应包含客户隐私或专有内容。

## 成本控制

- Image 2 默认跟随 PPT 总页数，也可指定 1–50 页；每页独立计费。
- 当前整页融合模式不调用反向视觉拆解，避免把截图裁剪误称为可编辑对象。
- 只需要内容时可关闭 “Image 2 生图”，图片与视觉校验阶段会跳过。
- 内置风格图和用户参考图都会计入图片输入成本。
