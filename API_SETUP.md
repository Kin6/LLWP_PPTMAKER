# DeckForge API 配置

DeckForge 的本地模式不需要任何 API。只有在页面顶部切换到“AI 增强”后，才会请求模型服务。

## 需要哪些 API

### 1. 内容模型 API（AI 增强必需）

用于把文字、表格摘要与图片说明整理为 DeckSpec，包括标题、页面顺序、要点、演讲备注和来源说明。

- OpenAI：使用 `POST /v1/responses`
- OpenAI 兼容服务：使用 `POST /v1/chat/completions`
- Ollama / LM Studio：使用其本机 OpenAI 兼容地址，不需要云端 Key

### 2. 图片生成 API（可选）

用于为封面和关键章节生成视觉图。当前实现使用 OpenAI `POST /v1/images/generations`，默认模型为 `gpt-image-2`。关闭“生成配图”时不会产生图片 API 调用。

## Key 填在哪里

推荐方式是在项目根目录创建 `.env.local`：

```dotenv
OPENAI_API_KEY=你的_key
TEXT_API_BASE_URL=https://api.openai.com/v1
TEXT_MODEL=gpt-5.4-mini
IMAGE_MODEL=gpt-image-2
```

然后重新运行：

```powershell
npm run dev
```

也可以在网页的“API 设置”中填写 Key。页面中的 Key 使用密码输入框，并且只保存在当前浏览器会话的 `sessionStorage`；关闭标签页后会清除。每次生成时，Key 只发送到本机的 `/api/ai/*` 路由，由本地 Express 服务转发给模型提供商。

## 本地模型示例

Ollama 的默认兼容地址：

```text
http://127.0.0.1:11434/v1
```

先在命令行准备模型，再在页面选择“Ollama 本地”，填写实际模型名：

```powershell
ollama pull qwen3:8b
ollama serve
```

本地模型只负责内容结构，不调用云端服务；是否生成配图仍由独立的图片 API 开关决定。
