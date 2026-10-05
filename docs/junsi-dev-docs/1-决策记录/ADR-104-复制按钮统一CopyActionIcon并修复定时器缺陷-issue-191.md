# ADR-104：复制按钮统一 CopyActionIcon，并修复其定时器被 cleanup 清掉的缺陷（issue #191）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-05 |
| 决策者 | AI Agent |

## 背景

用户报告资源详情页新增的「复制资源名称」按钮没有图标动画（其他同类按钮都有）。排查确认：项目早在提交 `4834cca`（「联机房间复制动画修复」）就引入了 `src/components/CopyActionIcon.tsx` —— 专为「复制 → 勾选反馈」封装，内含 `MorphIcon` 形变动画；`Connect.tsx` 的房间码/服务器地址复制按钮已在用。而我实现 ResourceDetail 复制按钮时写成三元硬切换 `{nameCopied ? <Check/> : <Copy/>}` 绕过了它，还各自重复实现了一遍 800ms 定时器。

全项目排查（`clipboard.writeText` 12 处 + `? <Check` 三元全量）结论：同类硬切换共 3 处 —— ResourceDetail、`LicenseActivationDialog.tsx:95`、`Settings.tsx:474`；其余 6 处无图标反馈语义（仅弹 toast），另有若干是「一侧为 null/文本」或静态图标，判定不适用。

进一步发现项目**此前已系统性做过**同类迁移：`docs/junsi-dev-docs/6-UI/组件设计/MAPPING_TABLE-icon-ternary-to-MorphIcon.yaml` 记录了「icon↔icon 三元 → MorphIcon」的逐文件映射、通用模式与 `not_converted` 判定标准，并产出 `MorphActionIcon`。说明该约定已存在、但**未写进 agent 必读的 `AGENTS.md`**，因此新代码仍会重犯。

修复过程中实测发现 `CopyActionIcon` 自身潜伏缺陷：勾选态不复位（点击后 1500ms 仍为 `text-emerald-500`），且第二次点击不再触发动画。判别实验：把父级复位延到 3s 后，图标在子组件 `flashMs`(800ms) 正常自行复位 → 证实根因是「父级在同样时长（默认同为 800ms）把 `copied` 置回 false 时，effect cleanup 恰好清掉子组件尚未触发的复位定时器」。`Connect.tsx` 同受影响。

## 决策

**① 3 处复制按钮统一改用 `CopyActionIcon`**（ResourceDetail / LicenseActivationDialog / Settings），移除各自的 `{copied ? <Check/> : <Copy/>}` 硬切换与重复定时器逻辑；父级仍保留「把 `copied` 置回 false + 连点先清旧定时器」的写法（与 `Connect.tsx` 一致）——因为组件只在 `copied` 出现 false→true 跳变时才启动动画，父级不复位则第二次点击无效。

**② 修复 `CopyActionIcon` 的定时器缺陷（根因修复，Connect 亦受益）**：把复位定时器从「依赖 `copied` 的 effect + 返回 cleanup」改为 **ref 持有**，只在 `copied === true` 时启动/续期（连点先清旧定时器），卸载时用独立的空依赖 effect 清理。这样父级把 `copied` 置回 false 时不再误清尚未触发的复位定时器。

**③ 把约定写进 agent 必读处，防止再犯**：
- `AGENTS.md` Frontend conventions 新增两条 —— 「Copy buttons 用 `CopyActionIcon`，不要手写三元（并说明父级为何仍须复位）」、「禁止手写 icon↔icon 三元切换，按场景选 `MorphIcon`/`CopyActionIcon`/`MorphActionIcon`，并指向迁移映射表」。
- `docs/junsi-dev-docs/6-UI/组件设计/UI设计规范.md` 新增「5.3 状态切换图标：禁止三元硬切换」：组件选择表、`CopyActionIcon` 的两个要点（父级必须复位、不要自己再写一遍）、以及 `not_converted` 判定情形；组件表补 `MorphActionIcon`/`CopyActionIcon`。

**明确不做**：不把 toast-only 的 6 处复制点加图标反馈（无该语义，属扩大范围）；不统一闪烁时长（License/Settings 为 2000ms、组件默认 800ms，统一会改变既有交互）。

## 备选方案

（未记录备选方案）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-05 | v1.0 | 初版创建 | AI Agent |