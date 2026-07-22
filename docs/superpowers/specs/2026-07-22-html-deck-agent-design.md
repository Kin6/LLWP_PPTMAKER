# HTML Deck Agent 重构设计

日期：2026-07-22

状态：已完成产品讨论，等待书面规格确认

## 摘要

HTML 模式保留现有材料解析和来源追踪，删除 `NotebookDeckSpec -> HtmlDeckSpec -> 对象编辑器` 主链路，改为一个受限的 Deck Agent Artifact 工作流：

```text
材料解析
-> slides-content.md
-> 单一 design-brief.md
-> 两页自动校准
-> 分批生成逐页 HTML/CSS
-> 按真实图片槽生成素材
-> DOM 校验和视觉评审
-> 局部返修
-> 独立 HTML 交付
```

第一版采用自然语言修改，不提供拖拽、缩放、属性面板或任意 JavaScript 生成。前端使用类似 Manus 的 Agent 消息流展示步骤和产物，但不复制 Manus 品牌。

## 背景与问题

当前 HTML 模式的主要流程位于 `src/App.tsx` 的 `runHtmlPipeline`，依次完成内容策划、逐页图片生成、`HtmlDeckSpec` 编排、编辑器初始化和导出。服务端通过单次模型调用生成严格 JSON；模型同时决定内容、坐标、字体、层级、交互和图片位置。

现有方案的问题包括：

- `x/y/w/h/zIndex` 通过 Schema 校验不代表页面具有良好视觉质量。
- 内容策划、视觉设计和底层对象布局耦合在一个大 JSON 中。
- 图片在最终布局槽位确定前生成，构图与页面不一定匹配。
- 整套 JSON 失败或超限时影响全部页面，局部重试成本高。
- Patch 持续修改底层对象坐标，长期容易产生不可预测的页面状态。
- 现有服务端没有工具调用循环、文件工作区、浏览器检查或截图返修能力，复制 `SKILL.md` 本身不会形成 Agent。

## 目标

- 保留 `attachmentParser.ts`、`ExtractedBlock`、`SourceLocation` 和 `sourceRefs`。
- 材料解析后先生成可读、可下载、可预览的 Markdown PPT 大纲。
- Markdown 生成后自动进入下一阶段，不要求用户确认。
- 使用一个专门的 Deck Agent Worker 驱动 HTML 生成、渲染、检查和返修。
- 将成熟开源 Skill 的工作流、主题、布局和 QA 能力分阶段封装进内部 Skill。
- 生成视觉自由度较高的 HTML/CSS，同时保持固定运行时和安全边界。
- 每个阶段保存检查点，失败时局部恢复。
- 控制正常路径的模型调用次数、上下文重复和返修次数。
- 最终生成可离线运行的独立 HTML Artifact。

## 非目标

第一版不包含：

- 拖拽、缩放和属性面板。
- 用户直接编辑 `slides-content.md`。
- 三套视觉方向生成、比较或人工选择。
- Agent 自定义 JavaScript、第三方 CDN 或任意网络资源。
- 任意 React、Vue、TSX、MDX 或用户代码执行。
- HTML 和 PPTX 的无损双向转换。
- 将自然语言修改反向同步到初始 Markdown 大纲。
- 多人实时协作。
- 自动继承旧版本的局部修改并重新生成整套演示。

## 核心设计决策

### 1. Markdown 是策划快照

`slides-content.md` 是材料解析后的第一个生成 Artifact。它负责描述：

- 整套叙事结构。
- 每页标题。
- 每页核心结论。
- 内容要点、事实、表格或时间线。
- 演讲备注。
- 人类可读的材料来源和稳定 `blockId`。

它不包含：

- 布局名称或组件类型。
- 视觉方向或配图 Prompt。
- 坐标、字号、颜色或动效参数。
- HTML、CSS 或 JavaScript。

第一版中，Markdown 在初次生成后保持只读。它是策划快照，不承担后续所有修改的实时事实源。最终 HTML/CSS/assets 是演示文稿当前版本的事实源。

### 2. 不再使用 NotebookDeckSpec

HTML 主链路不再构造或消费 `NotebookDeckSpec`，也不再用一个新的内容 JSON 复制其职责。

系统只保留薄的操作元数据：

- `job.json`：任务阶段、进度、重试、错误和当前 revision。
- 页面 manifest：稳定 `slideId`、文件名、顺序、状态和来源引用。

操作元数据不保存完整页面文案、坐标或视觉布局。

### 3. 单一设计方向和自动校准

Design Director 只生成一份 `design-brief.md` 和一份 `theme.css`。不生成三套候选方案，不等待用户选择。

批量生成前先生成两个代表页面：

- 封面页。
- Markdown 中信息密度最高的内容页。

系统对这两页执行 DOM 检查和一次视觉评审。必要时允许修正 `design-brief.md`、`theme.css` 和校准页面一次，然后锁定本次任务的设计规则。

### 4. HTML Artifact，而不是对象模型

每页保存为独立 HTML 片段和作用域 CSS：

```text
slides/slide-01.html
slides/slide-02.html
theme.css
assets/
```

页面使用固定 1920 x 1080 画布、稳定 `slideId` 和 `data-source-refs`。最终由网站提供的固定 Reveal.js 运行时组装。

Agent 可以生成页面 HTML 和作用域 CSS，但不能生成 JavaScript。导航、过渡、动画、图表和演讲者模式由固定、本地、版本化的运行时提供。

### 5. 确定性编排，受限 Agent 执行

代码状态机决定阶段顺序、重试、检查点和调用预算。模型不能自行跳过校准、校验或安全检查。

Agent 只在当前阶段获得必要工具和必要 Skill 引用。它不能获得任意 shell、包管理器、项目目录或宿主机文件系统访问权。

## Markdown 契约

Markdown 采用 Manus 风格的半结构化格式，不使用 YAML Frontmatter，不要求所有页面具有完全相同的小标题。

```markdown
# 智能制造转型方案

> **叙事主线：** 现状问题 -> 核心证据 -> 解决路径 -> 实施优先级 -> 行动建议

## 幻灯片 1：封面

**主标题：** 从单点自动化走向数据闭环

**副标题：** 面向管理层的智能制造转型方案

**核心观点：** 真正的效率提升来自系统协同，而不是继续堆叠设备。

**演讲备注：** 开场先强调本次汇报关注经营结果，而不是技术概念。

**材料来源：**

- 《智能制造调研报告》第 3 页 <!-- source:block-018 -->

## 幻灯片 2：当前效率损失集中在三个信息断点

**核心观点：** 设备、生产计划和质量数据之间尚未形成闭环。

**关键事实：**

- 生产数据需要人工汇总
- 质量问题无法及时回溯
- 多套系统之间缺少统一标识

**演讲备注：** 用三个具体断点解释已有投入为何未转化为整体效率。

**材料来源：**

- 《智能制造调研报告》第 8 页 <!-- source:block-031 -->
- 《工厂访谈记录》生产章节 <!-- source:block-047 -->
```

解析和校验规则：

- 唯一一级标题表示演示标题。
- `## 幻灯片 N：标题` 表示页面边界。
- 每页必须具有核心观点、演讲备注和材料来源。
- `内容点`、`关键事实`、`时间轴`、`对比`、`行动建议` 等栏目允许按内容变化。
- 标准 Markdown 表格原样保留。
- 所有 `source:block-id` 必须在本次 `ExtractedBlock` 集合中存在。
- 除 `<!-- source:block-id -->` 来源注释外，Markdown 不能包含视觉布局、配图 Prompt、其他 HTML、CSS 或内部工作流说明。
- 首次校验失败时自动修复一次；再次失败时任务停留在 outline 阶段。

## Agent 前端交互

生成页采用 Agent 对话和步骤时间线，而不是传统设置面板加编辑器工作区。

### Agent 回复结构

- Agent 先用自然语言复述任务目标、受众、页数和当前动作。
- 每个阶段显示状态图标、标题、耗时或页数进度。
- 点击阶段标题展开或折叠阶段详情。
- 完成的文件以 Artifact 行展示，例如 `slides-content.md`。
- 点击文件名打开右侧只读预览；关闭后回到原来的消息位置。
- 展开、折叠和预览不影响后台生成。
- 当前阶段实时更新，但不把底层 API、Prompt 或内部 Schema 暴露给用户。

`slides-content.md` 属于“大纲生成”阶段；第二阶段可以展示 HTML 生成产生的页面大纲或缩略图，两者不能混为同一 Artifact。

### 任务操作

第一版提供：

- 取消当前任务。
- 重试失败阶段。
- 从检查点继续。
- 预览最终 HTML。
- 下载独立 HTML。
- 用自然语言修改目标页。
- 撤销最近一次已发布修改。

## 服务端架构

### 模块

```text
DeckJobOrchestrator
  -> SkillLoader
  -> AgentRunner
  -> ArtifactStore
  -> DeckRenderer
  -> DeckVerifier
  -> EventStream
```

职责：

- `DeckJobOrchestrator`：固定状态机、调用预算、取消、重试和检查点。
- `SkillLoader`：只加载当前阶段所需的规则、示例和资产索引。
- `AgentRunner`：执行受限模型工具循环，不直接访问宿主文件系统。
- `ArtifactStore`：原子保存 Markdown、HTML、CSS、图片、QA 报告和 revision。
- `DeckRenderer`：组装固定 Reveal.js 运行时并启动隔离预览。
- `DeckVerifier`：执行 DOM 检查、截图、视觉评审和目标页复检。
- `EventStream`：将带序号的任务事件推送给前端，支持断线后续传。

### 任务工作区

开发环境默认使用已被 Git 忽略的目录：

```text
artifacts/deck-jobs/<jobId>/
  job.json
  events.ndjson
  source-blocks.json
  slides-content.md
  design-brief.md
  theme.css
  manifest.json
  slides/
  assets/
  revisions/
  qa/
    report.json
    screenshots/
  dist/
    index.html
```

生产环境通过 `DECK_JOB_ROOT` 指向应用数据卷，不能写入代码目录。

### 任务状态

```text
queued
-> outline
-> design
-> calibrating
-> building
-> generating-assets
-> verifying
-> repairing
-> ready
```

附加终态为 `ready`、`needs-review`、`failed` 和 `cancelled`。每次状态变化以单调递增事件序号写入 `events.ndjson`，前端可按最后序号恢复消息流。`job.json` 只保存当前状态和最后事件序号，不累积完整事件历史。

## Skill Pack 设计

内部只注册一个可触发 Skill：

```text
skills/generate-html-deck/
  SKILL.md
  agents/openai.yaml
  references/
    content-density.md
    design-direction.md
    layout-catalog.md
    visual-rubric.md
    source-provenance.md
    security-contract.md
  assets/
    runtime/
    themes/
    layouts/
  scripts/
    validate-outline.mjs
    assemble-deck.mjs
    inspect-dom.mjs
    capture-slides.mjs
    package-deck.mjs
```

`SKILL.md` 保持简短，只描述阶段顺序、停止条件和何时读取某个 reference。详细设计知识按阶段渐进加载，避免所有上游 Skill 同时占用上下文或给出冲突指令。

### 上游来源及角色

| 来源 | 审核版本 | 第一版采用内容 | 不直接采用内容 |
| --- | --- | --- | --- |
| [frontend-slides](https://github.com/zarazhangrui/frontend-slides) | `9906a34` | 内容密度、风格检索、固定画布、预览和 QA 规则 | Vercel 部署、运行时安装、任意脚本执行 |
| [html-ppt-skill](https://github.com/lewislulu/html-ppt-skill) | `f3a8435` | `base.css` Token 思路、精选主题、布局片段、CSS 动画 | 流式 viewport 规则、CDN、`--no-sandbox` 渲染和未校验消息协议 |
| [huashu-design](https://github.com/alchaincyf/huashu-design) | `c9b0671` | 品牌资产规则、单方向设计规范、视觉评审量表、两页校准 | 三方向人工 Gate、本地文件和操作系统工作流 |
| [revealjs-skill](https://github.com/ryanbbrown/revealjs-skill) | `d0ccd34` | overflow、图表、逐页截图和定向复检思路 | 未鉴权编辑服务器、未固定 CDN 和原样脚本 |
| [open-slide](https://github.com/1weiho/open-slide) | `3380558` | 稳定页面 ID、源文件 revision 和评论式修改思路 | 任意 React/TSX 执行和 Vite 文件系统编辑 |
| [Slidev](https://github.com/slidevjs/slidev) | `36063a1` | 类型化的页面操作和原子更新思路 | Vue/Vite/MDX 运行时和任意组件执行 |

上游仓库仅作为审核过的知识和资产来源。项目不把它们的原始 `SKILL.md` 全部注册给 Agent，也不在 Express 进程中直接运行其脚本。

复制或实质改编 MIT 代码、CSS、模板或文档时，固定上游 commit，并在 `THIRD_PARTY_NOTICES` 和相应发布包中保留版权及许可证。字体、图片、品牌、Chart.js、Reveal.js 等第三方资产单独记录许可证和来源。

## 受限 Agent 工具

按阶段提供最小工具集合：

```text
read_source_blocks
read_outline
write_outline
write_design_brief
write_theme
write_slide
generate_asset
render_deck
inspect_slide
capture_slide
patch_slide
publish_deck
```

约束：

- 所有路径由服务端映射到当前 `jobId`，模型不能提交绝对路径或 `..`。
- 写入操作限制文件类型、单文件大小和总任务空间。
- `write_slide` 使用 HTML/CSS 解析器执行白名单校验，不依赖正则清洗。
- 模型不能运行 shell、安装依赖、启动服务器或访问代码仓库。
- 图片工具只接受结构化素材请求、目标宽高比和来源引用。
- 工具结果返回短摘要；大文件按需读取，避免重复输入上下文。
- 每个阶段设置最大工具调用次数和总超时。

## 生成流程

### 1. 材料解析

沿用现有解析器产生 `ExtractedBlock[]` 和 `SourceLocation`。解析结果保存为 `source-blocks.json`，并继续作为来源合法性的唯一依据。

### 2. Markdown 大纲

Outline Agent 根据材料、主题、受众和页数生成 `slides-content.md`。程序解析 Markdown AST 并执行格式、页数和引用检查。通过后立即发出 Artifact 事件并进入 design 阶段，不等待用户确认。

### 3. 单一设计规范

Design Director 根据以下输入生成一个方向：

- `slides-content.md`。
- 用户选择的风格或默认风格。
- 用户上传的品牌和内容素材。
- 内容密度、观看距离和演讲场景。
- 精选的上游设计规则和布局目录。

输出 `design-brief.md` 和 `theme.css`，定义画布、字体、字号层级、色彩、网格、留白、图像语法、图表语法、动效等级和禁止项。

### 4. 两页自动校准

生成封面和信息密度最高页面，执行：

- 固定 1920 x 1080 渲染。
- DOM 溢出、断图、字体和 ID 检查。
- 两页截图视觉评审。
- 必要时修正一次设计规范和页面。

用户可以查看校准产物，但不会被要求选择或确认。

### 5. 分批生成页面

校准完成后，其余页面按 2 至 3 页一批生成，最多并行两个批次。

每批输入：

- 全局标题、叙事主线和 design brief 摘要。
- 当前批次的完整 Markdown 页面段落。
- 前后相邻页的标题和核心观点。
- 可用素材目录及来源信息。
- 允许的 HTML 元素、CSS 属性和运行时组件。

每页独立保存并立即执行确定性校验。批次失败不撤销其他成功批次。

### 6. 素材生成

初版页面先声明真实图片槽，包括用途、宽高比、主体安全区和来源要求。

素材处理顺序：

1. 匹配用户上传的内容素材。
2. 匹配内部素材库中已经记录合法来源和适用许可的素材。
3. 根据图片开关和数量生成缺失素材。
4. 无可用素材或生成失败时切换到无图片布局。

图片回填后重新渲染受影响页面。图片生成不允许在画面内生成演示文稿文字。

### 7. 自动验收和返修

确定性检查包括：

- 页面数量、稳定 ID 和顺序。
- `scrollWidth/scrollHeight` 溢出。
- 文字、图表和图片是否超出安全区。
- 断图、字体加载失败和控制台错误。
- 重复 ID、无效来源引用和缺少讲稿。
- 禁止元素、脚本、事件属性、外部 URL 和 CSS 越界选择器。
- 空白画布和过低内容占用率。

视觉评审使用整套缩略图联系表加必要的单页大图，检查：

- 观点层级和阅读顺序。
- 内容密度、留白和平衡。
- 页面重复、模板感和跨页一致性。
- 图像与本页观点的相关性。
- 色彩、字号、对齐和观看距离。

正常路径只执行一次整套视觉评审。只返修失败页面，最多一轮。返修后只重新截图受影响页面。

### 8. 发布

验收通过后将固定运行时、`theme.css`、页面 HTML 和本地素材打包为独立 `dist/index.html`。发布包不包含 API Key、聊天上下文、任务工作区或 Agent 工具。

## 性能和成本预算

以 10 页演示为例，正常文本模型路径的目标调用数为：

- Markdown 大纲：1 次。
- 单一设计规范：1 次。
- 两页校准生成：1 次。
- 校准视觉评审：1 次。
- 其余页面批量生成：约 3 次。
- 整套视觉评审：1 次。

图片调用数由用户设置决定。结构校验和 DOM 检查均在本地执行，不调用模型。

性能规则：

- HTML 批次为 2 至 3 页，最多两个并发批次。
- Skill 参考按阶段加载，不重复发送完整上游 Skill。
- 视觉评审先使用联系表，只有失败页面读取大图。
- 校准最多修正一次，正式页面最多返修一次。
- 成功页面立即保存，失败重试不重做成功页面。

## 自然语言修改和 revision

第一版不反向修改 `slides-content.md`。

修改流程：

```text
用户指令
-> 判断是单页修改、明确的多页修改还是整套主题修改
-> 读取目标页、相邻页和 design-brief 摘要
-> 创建候选 revision
-> 修改目标 HTML/CSS/assets
-> 对所有受影响页面执行 DOM 检查和截图
-> 通过后原子发布
```

没有显式页码时，修改默认作用于用户当前预览页。明确指定多页时只修改这些页面。整套主题修改可以更新 `theme.css`，但必须重新检查所有页面；整套叙事重写不作为局部修改处理，而是创建新 job。

设计或内容修改都直接作用于当前 HTML Artifact。每个 revision 记录：

- 原始用户指令。
- 修改范围和目标 `slideId[]`。
- 修改文件集合。
- 父 revision。
- 校验结果和时间。

失败的候选 revision 不替换当前版本。撤销只需切回父 revision。

“整套重新生成”会从原始 `slides-content.md` 创建新 job，不自动继承旧 job 的局部修改，并在用户操作前明确提示。

## 安全边界

生成 HTML 视为不可信输入。

- 预览运行在隔离域，或使用不含 `allow-same-origin` 的严格 sandbox iframe。
- CSP 默认拒绝网络、表单、顶层导航、插件和子框架。
- 禁止 `<script>`、事件属性、`javascript:`、`data:text/html`、任意 iframe/embed/object 和外部 CSS。
- CSS 禁止外部 `url()`、全局宿主选择器、超出 slide 根节点的选择器和资源消耗型规则。
- Reveal.js、图表、字体和动画依赖固定版本并由本地提供。
- Agent 工作区不含 API Key 或主应用凭据。
- Playwright Worker 具有任务级超时、内存、CPU、磁盘和网络限制。
- 所有素材路径执行真实路径包含检查，禁止符号链接逃逸和路径穿越。
- 固定运行时和讲稿组件不得把未经转义的用户文本插入 `innerHTML`；生成页面必须先经过 HTML 解析器和白名单清洗再保存。
- `postMessage` 必须校验 `origin`、`source`、消息类型、jobId 和 revision。

## 失败、取消和恢复

- 网络或模型超时：当前阶段自动重试一次。
- Markdown 不合格：只修复 Markdown 一次；仍失败则停留在 outline。
- 校准失败：修正一次；仍失败则切换到经过验证的默认主题。
- HTML 批次失败：保留其他批次，只重试失败批次。
- 图片失败：使用用户素材或无图片布局，不阻塞整套。
- DOM 失败：先尝试确定性修复，再交给 Agent。
- 视觉失败：只返修失败页一次；仍失败则进入 `needs-review` 终态，允许预览但不标记正式完成。
- 用户取消：通过 `AbortController` 终止未完成请求和浏览器任务，已完成 Artifact 保留。
- 页面刷新或服务重启：从 `job.json` 和最后一个完整检查点恢复。
- 原子写入采用临时文件加 rename，避免中断后留下半个页面或半份 manifest。

## API 和事件模型

建议使用任务 API，而不是让一个 HTTP 请求承担整套生成：

```text
POST   /api/html-deck/jobs
GET    /api/html-deck/jobs/:jobId
GET    /api/html-deck/jobs/:jobId/events?after=<seq>
GET    /api/html-deck/jobs/:jobId/artifacts/:artifactId
POST   /api/html-deck/jobs/:jobId/cancel
POST   /api/html-deck/jobs/:jobId/retry
POST   /api/html-deck/jobs/:jobId/messages
POST   /api/html-deck/jobs/:jobId/undo
```

事件沿用项目现有 NDJSON 流模式，但每条事件包含稳定序号，支持重连：

```json
{
  "seq": 42,
  "jobId": "job-123",
  "stage": "building",
  "type": "artifact",
  "status": "done",
  "title": "整理幻灯片内容大纲并写入 Markdown",
  "artifactId": "slides-content",
  "progress": { "completed": 1, "total": 1 }
}
```

## 现有代码迁移

### 保留

- `src/lib/attachmentParser.ts`。
- `ExtractedBlock`、`SourceLocation` 和来源显示逻辑。
- API 配置和图片生成客户端中可复用的部分。
- Reveal.js、ECharts、Playwright 和现有安全 iframe 经验。
- 独立 HTML 导出的资源内联思路。

### 替换或退出 HTML 主链路

- `src/App.tsx` 中的 `runHtmlPipeline`。
- `src/html-deck/types.ts` 的 `HtmlDeckSpec` 对象模型。
- `src/html-deck/schema.ts` 的坐标节点 Schema。
- `src/html-deck/fromNotebook.ts`。
- `src/html-deck/HtmlDeckWorkspace.tsx` 的对象编辑器。
- `src/html-deck/document.ts` 的对象运行时拼装。
- `src/html-deck/patches.ts` 的底层对象 Patch。
- 服务端 `/api/ai/generate-html-deck*` 和 `/api/ai/patch-html-deck*`。
- 服务端 `buildHtmlDeckPrompt`、`buildHtmlPatchPrompt` 及相关坐标布局 Prompt。

### 新增边界

```text
src/deck-agent-ui/
  AgentRunView.tsx
  AgentMessage.tsx
  AgentStep.tsx
  ArtifactPreview.tsx
  DeckPreview.tsx

server/deck-agent/
  orchestrator/
  skill-loader/
  runner/
  workspace/
  renderer/
  verifier/
  routes/

skills/generate-html-deck/
```

## 测试策略

### 单元测试

- Markdown AST 分页、自由栏目、表格、备注和来源解析。
- 页数、必需栏目和 `source:block-id` 校验。
- Skill 阶段路由和上下文预算。
- Job 状态转换、事件序号和检查点。
- 路径包含、文件类型、大小限制和原子写入。
- HTML/CSS 白名单清洗。
- revision 创建、发布、失败回滚和撤销。

### 集成测试

- 使用 mock model 完成 outline -> design -> calibration -> build -> verify -> ready。
- 模型超时、无效 Markdown、失败批次、图片失败和视觉返修。
- 取消任务并从检查点继续。
- NDJSON 断线后按事件序号恢复。
- 单页和多页自然语言修改只影响明确目标；整套主题修改重新验证全部页面；失败 revision 不替换当前版本。

### 浏览器与视觉测试

- 固定 1920 x 1080 画布非空且比例正确。
- 桌面和移动视口缩放不改变幻灯片内部布局。
- 无文本、图片、图表或控制栏重叠。
- 无 DOM overflow、断图、字体失败、重复 ID 或控制台错误。
- Markdown Artifact 可点击打开只读预览。
- 阶段标题可展开和折叠，操作不影响后台任务。
- 预览 iframe 无法读取主应用存储、API 配置或网络。
- 最终独立 HTML 在离线浏览器中可翻页和演示。

固定测试材料至少覆盖：

- 文字密集的报告。
- 含表格和图表的数据材料。
- 图片密集的作品集或产品材料。

## 验收标准

- HTML 模式不再创建或调用 `NotebookDeckSpec` 和 `HtmlDeckSpec`。
- 材料解析后能生成符合契约的 `slides-content.md`，并保留可验证来源。
- 大纲生成后不等待用户确认，自动进入单一设计方向。
- 校准页通过检查后，其他页面按 2 至 3 页一批生成。
- Agent 无法写入 JavaScript、外部 URL 或任务目录以外路径。
- 每个成功阶段可恢复，失败不会清除已完成页面。
- 正常路径只执行一次整套视觉评审，返修限于失败页和一轮。
- Agent 前端符合已确认的消息流、步骤折叠和文件预览交互。
- 自然语言修改通过所有受影响页面的 QA 后原子发布，并可撤销。
- 最终输出为不含密钥、聊天和工具能力的独立 HTML。
- 安全、单元、集成和浏览器测试全部通过。

## 延后事项

以下能力明确延后，不影响第一版验收：

- Markdown 回写和内容双向同步。
- 三套视觉方向和人工选择 Gate。
- 拖拽、缩放、属性面板和组件级编辑器。
- 自定义 JavaScript 或用户插件。
- 可编辑 PPTX 导出。
- 多用户任务队列、配额计费和组织级权限。
- 自动重放旧版本局部修改到新生成的整套演示。
