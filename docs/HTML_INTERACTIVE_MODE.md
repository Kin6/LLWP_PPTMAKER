# HTML 交互演示模式

## 产品边界

HTML 模式是一个可恢复的演示文稿制作 Agent，不是自由代码编辑器。用户提交材料后，系统先自动生成可查看的 `slides-content.md`，随后直接完成设计、页面生成、素材处理和质量检查。用户不需要确认中间大纲，但可以在生成期间打开只读 Markdown。

第一版提供：

- 固定 1920 x 1080、16:9 的 Reveal.js 演示和 ECharts 图表。
- Manus 风格任务时间线、可折叠步骤和只读产物预览。
- 单一设计方向和代表页校准，不生成三套候选方案。
- 按批生成 HTML/CSS，失败后从持久化检查点重试。
- 对当前页或明确选中页面发起自然语言修改，验证通过后原子发布新 revision。
- 撤销到上一已发布 revision，以及下载可离线运行的单文件 HTML。

第一版不提供元素拖拽、缩放、属性面板、图层编辑、浏览器端对象持久化或 HTML 转 PPTX。需要可编辑 PowerPoint 时，应使用本地、标准或融合成片 PPTX 模式。

## 生成流程

```text
attachmentParser
  -> 结构化 sourceBlocks 与上传素材
  -> slides-content.md
  -> 单一 design brief / theme
  -> 代表页 calibration
  -> 分批 HTML/CSS 页面
  -> 素材匹配或生成
  -> DOM、截图和视觉 QA
  -> revisioned standalone HTML
```

`slides-content.md` 只包含叙事结构、页标题、核心结论、要点、讲稿提示和材料来源。模型不能在这个阶段加入布局坐标、配色、动效或实现代码。大纲写入后任务自动进入设计阶段。

每页以稳定的 `slide-XX` 标识保存为受限 HTML 片段和作用域 CSS。服务端负责套入固定运行时、来源引用、讲稿备注和素材；模型不能提交脚本、事件处理器、外链、iframe、表单或任意运行时代码。

## Agent 交互

- 步骤标题可点击展开或折叠；已生成的大纲默认展开。
- 点击 `slides-content.md` 会打开只读 Markdown，关闭后恢复时间线滚动位置和焦点。
- 刷新页面后，`?job=<jobId>` 会恢复任务快照，并从最后接收的事件序号继续播放，不重复时间线记录。
- `ready` 表示 QA 已通过并发布；`needs-review` 表示已生成可预览版本，但自动修复预算用尽，仍需人工复核。
- 非终态任务可以取消。取消会先停止 worker 并封住后续写入，再标记任务为 `cancelled`。
- `failed`、`cancelled` 和 `needs-review` 可以重试；已经完成的安全产物不会被删除。
- revision 修改在候选目录中完成，只有目标页检查通过后才更新公开指针。失败候选不会替换当前版本。

## 安全边界

- 预览 iframe 只使用 `sandbox="allow-scripts"`，没有同源、表单、弹窗、下载或顶层导航权限。
- CSP 默认拒绝所有能力；脚本和样式以哈希授权，`connect-src`、`worker-src`、`frame-src`、`object-src`、`form-action` 和 `navigate-to` 均为 `none`。
- 预览消息同时校验来源窗口、opaque origin、随机 channel token、Job ID、数字 revision 和页面 ID。伪造消息不会翻页。
- Reveal.js 6.0.1、ECharts 6.1.0 和本地 bridge 由运行时清单固定版本与 SHA-256；启动时哈希不符会拒绝生成。
- API Key、Base URL、Provider 和模型只能来自服务端环境变量。Job 请求、事件、Markdown、预览和下载文件都不保存这些字段。
- standalone HTML 内联运行时和素材，不包含 Job 路径、聊天记录、系统提示词或网络 URL。

## 持久化与限额

Job 默认保存在仓库根目录下被忽略的 `.deck-jobs/`；生产环境必须通过 `DECK_JOB_ROOT` 指向独立持久卷。每个目录包含状态、事件、来源、大纲、页面、QA 证据和已发布 revisions。

默认硬限额：

| 项目 | 限额 |
| --- | ---: |
| 单个 Job 工作区 | 512 MiB |
| Markdown 文件 | 2 MiB |
| 单页 HTML | 200 KiB |
| 单页 CSS | 120 KiB |
| JSON 文件 | 10 MiB |
| 单张图片 | 12 MiB |
| standalone HTML | 256 MiB |
| 页面数 / 上传图片数 | 50 |

服务不会自动删除终态 Job。运维侧应按业务保留期备份或清理终态目录，并在删除前确认 Job 没有 active worker；不得删除 active Job。临时 Chromium profile 会在每次 QA 的 `finally` 阶段清除。

## 部署要求

安装依赖和 Chromium：

```bash
npm ci
npx playwright install chromium
```

Node worker 使用 512 MiB old generation、64 MiB young generation 和 8 MiB stack 限制，但这些限制不覆盖 Chromium 子进程。生产部署必须把应用 worker 和 Chromium 进程树放入容器或操作系统 sandbox，并显式设置 CPU、RSS、进程数、磁盘和网络限制；具体额度应按最大页数和并发量压测后确定。未设置外部限制时，不应将 HTML 生成接口直接暴露为多租户服务。

## 验收

```bash
npm run test:html-deck
npm run build
node --check server/index.mjs
git diff --check
```

HTML 套件覆盖桌面 1440 x 900 和移动端 390 x 844、只读大纲、刷新恢复、重试/取消、revision/undo、sandbox 能力隔离、离线下载，以及内部 1920 x 1080 页面非空、无溢出、无断图、无重复 ID、字体与图表加载成功。
