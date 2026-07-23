# Third-Party Notices

This project bundles the following browser runtimes into generated standalone HTML presentations. Exact package versions are pinned in `package-lock.json` and runtime file hashes are pinned in `skills/generate-html-deck/assets/runtime/runtime-manifest.json`.

## Bundled Runtime Dependencies

### Reveal.js 6.0.1

- Repository: https://github.com/hakimel/reveal.js
- Package and version: `reveal.js@6.0.1`
- Copyright: Copyright (C) 2011-2026 Hakim El Hattab and reveal.js contributors
- License: MIT
- Retained license text: `node_modules/reveal.js/LICENSE`

### Apache ECharts 6.1.0

- Repository: https://github.com/apache/echarts
- Package and version: `echarts@6.1.0`
- Copyright: Copyright 2017-2026 The Apache Software Foundation
- License: Apache License 2.0, including the separately identified subcomponent terms distributed with the package
- Retained license text: `node_modules/echarts/LICENSE`
- Retained notice text: `node_modules/echarts/NOTICE`

Generated standalone HTML includes a non-executable third-party notice comment. Repository URLs remain in this file and are intentionally omitted from generated artifacts so those artifacts remain network-independent and URL-free.

## Design References

The following six repositories and exact commits were reviewed only as design references. No source code, executable behavior, CSS, templates, or prose from any of the six repositories is copied into or bundled with this project. The local Skill, themes, layouts, and runtime integration are original implementations.

| Repository | Audited commit | License | Pinned license |
| --- | --- | --- | --- |
| `zarazhangrui/frontend-slides` | `9906a34` | MIT | https://github.com/zarazhangrui/frontend-slides/blob/9906a34/LICENSE |
| `lewislulu/html-ppt-skill` | `f3a8435` | MIT | https://github.com/lewislulu/html-ppt-skill/blob/f3a8435/LICENSE |
| `alchaincyf/huashu-design` | `c9b0671` | MIT | https://github.com/alchaincyf/huashu-design/blob/c9b0671/LICENSE |
| `ryanbbrown/revealjs-skill` | `d0ccd34` | MIT | https://github.com/ryanbbrown/revealjs-skill/blob/d0ccd34/LICENSE |
| `1weiho/open-slide` | `3380558` | MIT | https://github.com/1weiho/open-slide/blob/3380558/LICENSE |
| `slidevjs/slidev` | `36063a1` | MIT | https://github.com/slidevjs/slidev/blob/36063a1/LICENSE |

The detailed idea-level audit, including adopted concepts and rejected executable behaviors, is retained in `skills/generate-html-deck/references/upstream-audit.md`.
