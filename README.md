# LLWP_PPTMAKER

DeckForge 是一个本地优先的 AI PPT 制作器，可将文字、表格和图片整理为可编辑的 PowerPoint 文件。

## 功能

- 本地模式：无需 API，完成文本拆解、表格解析、图片取色、DeckSpec 生成和 PPTX 导出。
- AI 增强：支持 OpenAI Responses、OpenAI 兼容接口和 Ollama 本地模型。
- AI 配图：可选调用图片生成 API，为封面和关键页面生成视觉素材。
- 可编辑交付：标题、正文、表格、备注和来源均以原生 PPTX 对象输出。
- 多种输出：PPTX、HTML 演讲预览和 DeckSpec JSON。
- 内容检查：提供结构、证据和质量诊断，并允许逐页修改标题和要点。

## 本地运行

需要 Node.js 20 或更高版本。

```powershell
npm install
npm run dev
```

打开：<http://127.0.0.1:5173>

生产构建：

```powershell
npm run build
npm start
```

## API 配置

本地模式不需要 API。启用 AI 增强时，可以直接在网页的 API 设置中填写 Key，或将 `.env.example` 复制为 `.env.local`：

```dotenv
OPENAI_API_KEY=你的_key
TEXT_API_BASE_URL=https://api.openai.com/v1
TEXT_MODEL=gpt-5.4-mini
IMAGE_MODEL=gpt-image-2
```

网页填写的 Key 只保存在当前浏览器会话；`.env.local` 只由本地 Express 服务读取，并已加入 `.gitignore`。

完整接口说明见 [API_SETUP.md](./API_SETUP.md)。

## 验证

```powershell
npm run build
```

当前版本已验证本地生成、API 内容生成、API 配图、PPTX 导出，以及桌面和移动端布局。
