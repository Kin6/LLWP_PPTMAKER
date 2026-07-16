# 可编辑 PPTX 技术路线

## 结论

一张已经压平的 PNG 不包含文字框、图表数据、形状类型、连接关系或图层语义。对它做矩形裁剪只能得到截图碎片；SAM 类分割可以得到透明蒙版，但仍不能恢复原生文字、矢量图形和数据图表。

因此真正可拆卸的 PPT 必须采用“结构先行”，而不是“整页图片生成后反向猜结构”。

## 当前实现

- **原生可拆版**：Image 2 只生成每页独立主视觉；标题、正文、表格、强调框和基础形状由 PptxGenJS 生成成原生 PowerPoint 对象。
- **图文融合整页图**：Image 2 负责整页图文设计，视觉上限更高，但整页仍是一张图片，页面文字不可逐字编辑。
- 系统不再把矩形裁图描述成“真正拆解”。

## 推荐的开源升级

### 1. PPT Master：SVG 转 DrawingML

- 项目：https://github.com/hugohe3/ppt-master
- 许可证：MIT，需要保留署名。
- 路线：内容策略 -> 每页 SVG 场景 -> SVG 预处理 -> DrawingML -> 原生 PPTX。
- 优点：文字、形状、图标和矢量图都能成为可点击、可改色、可缩放的 PowerPoint 对象。
- 这是下一阶段最值得接入的主路线。

### 2. PptxGenJS：结构对象组装

- 项目：https://github.com/gitbrent/PptxGenJS
- 当前项目已经使用。
- 适合直接生成原生文字框、表格、形状、图表、图片和母版。
- 适合作为 SVG 转 DrawingML 之外的稳定对象层，并继续负责表格、备注和最终文件写出。

### 3. SAM 2：图片主体分割

- 项目：https://github.com/facebookresearch/sam2
- 许可证：Apache 2.0。
- 可用于把照片或 3D 主体从背景中分离为透明 PNG。
- 只能提升“图片对象可移动性”，不能恢复文字框、图表数据和矢量几何；Windows 本地部署通常需要 WSL、PyTorch 和较强 GPU。

### 4. PaddleOCR / PP-Structure

- 项目：https://github.com/PaddlePaddle/PaddleOCR
- 可识别截图中的标题、正文、表格和区域坐标。
- 适合作为导入截图或旧 PPT 的恢复工具，不应成为新 PPT 的主生成路线。

## 建议架构

1. 内容模型生成固定页数的 `DeckSpec`，包含总主张、逐页论证任务和跨页关系。
2. 版式模型生成 `SlideSceneSpec`，明确每个文本、形状、图表和图片槽位。
3. Image 2 仅生成照片、3D 主体、材质和插图，不生成需要编辑的文字。
4. 矢量装饰和信息图优先生成 SVG，再通过 PPT Master 转成 DrawingML。
5. PptxGenJS 组装原生文字、表格、图表、图片、备注和母版。
6. 当前产品为了优先保证成片质量，默认使用“图文融合整页图”；用户需要逐字编辑时再切换到原生分层模式。
