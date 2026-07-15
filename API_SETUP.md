# API 配置与五阶段实现

本地模式不需要 API。切换到页面顶部的“API”后，五阶段会按顺序执行，并把状态与错误显示在中间任务轨迹中。

## 需要哪些 API

### A. 文本与视觉模型

同一个多模态模型承担阶段 1 和阶段 3：

- **阶段 1，内容逻辑**：读取文字、表格、图片及图片说明，返回严格 JSON `DeckSpec`。
- **阶段 3，视觉拆解**：读取 Image 2 生成图，返回归一化文字安全区和主体裁剪框。

接口：

- OpenAI：`POST /v1/responses`
- OpenAI Compatible：`POST /v1/chat/completions`
- Ollama：OpenAI 兼容地址，例如 `http://127.0.0.1:11434/v1`

模型必须支持看图，才能同时使用用户图片和完成视觉拆解。纯文本本地模型只能完成不含图片的内容规划，阶段 3 会失败并在界面中明确提示。

### B. GPT Image 2

阶段 2 调用 `POST /v1/images/edits`，默认模型 `gpt-image-2`，不是简单的文字生图：

1. 服务端读取用户选择的 `public/style-guides/*.png`，作为第一张参考图。
2. 用户上传图作为后续参考图。
3. 提示词要求只从第一张图学习视觉语法，从用户图保持内容身份。
4. 生成图禁止文字、字母、数字、Logo 和水印，并要求预留低细节文字区域。

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

这些字段保存在当前标签页的 `sessionStorage`。关闭浏览器会话后清除，前端构建文件中不会写入 Key。

### 方式 2：`.env.local`

在 `D:\ppt_maker\.env.local` 中填写：

```dotenv
OPENAI_API_KEY=你的_key
TEXT_API_BASE_URL=https://api.openai.com/v1
TEXT_MODEL=gpt-5.4-mini
IMAGE_API_BASE_URL=https://api.openai.com/v1
IMAGE_MODEL=gpt-image-2
```

修改后重启：

```powershell
npm run dev
```

## 数据与隐私边界

- 本地模式不会请求外部模型。
- API 模式会发送文字、表格、压缩后的用户图片和生成图到所配置的模型服务。
- 用户原始图片不会写入项目目录；浏览器仅在当前页面会话中持有对象 URL。
- 内置风格图会随 Image 2 请求发送，它们只承担审美方向，不应包含客户隐私或专有内容。

## 成本控制

- Image 2 默认生成 2 张，可在 1–4 张之间调整。
- 视觉拆解把多张生成图合并为一次多模态请求。
- 只需要内容时可关闭 “Image 2 生图”，阶段 2 和 3 会跳过。
- 内置风格图和用户参考图都会计入图片输入成本。
