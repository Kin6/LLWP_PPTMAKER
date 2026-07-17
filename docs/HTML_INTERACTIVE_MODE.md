# HTML 交互演示模式

## 产品边界

该模式参考 Claude Design 的代码驱动设计工作流，但不是任意代码生成器。应用内版本是可编辑、可评论、可 AI 精修的结构化设计文档；导出的单文件 HTML 是可离线运行的交互快照；静态 PPTX 是兼容性交付物。三者不承诺无损双向转换。

已实现的核心能力：

- 1600 x 900、16:9 的结构化 `HtmlDeckSpec`。
- Reveal.js 翻页和 ECharts 原生图表。
- 文本、形状、图片、图表、视频和固定 Widget 节点。
- `click`、`hover`、`enter`、`key` 触发器。
- `next`、`previous`、`toggle`、`highlight`、`set-variable`、`animate` 动作。
- 选择、拖拽、缩放、属性编辑、撤销重做、评论、Tweaks 和 Draw。
- 目标页/目标对象级 AI Patch。
- IndexedDB 自动保存、逐页生图检查点、离线 HTML 和静态可编辑 PPTX。

当前不包含 Claude Design 的组织级多人实时协作、设计系统管理员锁定、Canva/Figma/Gamma 连接器、Claude Code handoff bundle，以及任意用户代码执行。

## 数据流

```text
用户材料
  -> NotebookDeckSpec（内容、页序、讲稿）
  -> GPT Image 2（独立无文字主视觉，1536 x 864）
  -> 安全 HtmlDeckSpec 初稿
  -> AI 设计规划（严格 JSON Schema）
  -> Zod 校验与素材 URL 回填
  -> sandbox iframe 运行时
  -> 编辑 / 评论 / Tweaks / Draw / AI Patch
  -> IndexedDB / standalone HTML / static PPTX
```

`HtmlDeckSpec` 是唯一源数据。DOM 只是渲染结果，拖拽和交互变量必须通过 `postMessage` 回写结构数据，不能把 iframe DOM 当作持久化状态。

## 安全边界

- iframe 使用 `sandbox="allow-scripts"`，不启用 `allow-same-origin`、表单、弹窗或顶层导航。
- CSP 默认拒绝所有能力，只允许内联/本机运行时脚本、内联样式和 `data:`/`blob:` 媒体；`connect-src`、`frame-src`、`object-src`、`form-action` 均为 `none`。
- Reveal 的窄屏滚动视图被禁用，避免 opaque origin 访问 `sessionStorage`；iframe 无法读取主应用的 API 配置和存储。
- AI Patch 只接受白名单字段。图片/视频的 `src` 不可由 Patch 修改，新增节点禁止 image/video，`__proto__`、`constructor` 和 `prototype` 被拒绝。
- 完整 Deck 和每个 Patch 都要再次通过 Zod 校验；失败时保留原稿。
- 服务默认只监听 `127.0.0.1`。环境变量中的 API Key 只能发送到环境里明确配置的 Base URL；其他地址必须提供独立会话 Key。

## 导出规则

单文件 HTML 内联 Reveal、ECharts 和所有 `blob:` 素材，保留放映、图表、动画和交互。它不包含主应用、聊天上下文或 API Key，因此不能继续接受自然语言修改。

静态 PPTX 保留：

- 文字框和基础样式。
- 形状和图片。
- 原生 PowerPoint 图表及数据。
- 讲稿备注。

静态 PPTX 降级：

- Web 动画和交互动作不保留。
- 视频输出为占位对象。
- Widget 输出为可编辑文字/基础形状。
- HTML 与 PowerPoint 字体排版可能有轻微差异。

## 高级组件路线

下一阶段应采用受控插件，而不是扩大模型可写 HTML 的权限：

1. 为 Three.js、Matter.js 和地图组件定义独立、版本化的 Widget Schema。
2. 运行时按节点类型懒加载固定适配器，导出时内联对应依赖。
3. Mapbox 等需要令牌或网络的组件必须提供静态地图降级，并在离线导出前显式提示。
4. 用户自定义代码必须进入第二层 sandbox iframe，通过窄消息协议接收只读数据，不能与 Deck iframe 或主应用同源。
5. 每种插件都要提供静态 PPTX 降级、资源大小上限、性能预算和浏览器兼容测试。

## 验收

```bash
npm run build
npm run test:html-deck
node --check server/index.mjs
git diff --check
```

浏览器验收至少覆盖桌面和移动端：iframe 非空、ECharts SVG 可见、对象选择/拖拽/缩放回写、评论和 AI Patch、Tweaks、Draw、放映交互、离线 HTML、PPTX ZIP 完整性、控制台错误和横向溢出。
