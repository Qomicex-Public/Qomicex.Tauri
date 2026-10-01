# ADR-093：取代 ADR-092 — 自实现 Windows IDropTarget，同时接文件与文本拖拽（修正 issue #136）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-02 |
| 决策者 | AI Agent |

## 背景

**本 ADR 取代 ADR-092 中关于 issue #136 的决策**（ADR-092 的 #138 部分仍然有效）。

ADR-092（随 PR #149 合并）采用「保留 Tauri 接管 + Rust 侧解析 `.url` 快捷方式文件」。该方案基于一个**未经真机验证的假设**——以为从浏览器拖链接进原生窗口时 Windows 会落成一个 `.url` InternetShortcut 文件。用户实测后回报「还是拖不进去」，假设被推翻。

复盘时查源码，得到完整的机制链（均为**已证明**证据）：

| 位置 | 事实 |
|---|---|
| `wry-0.57 src/webview2/drag_drop.rs` `iterate_filenames` | **只请求 `CF_HDROP`**；拿不到该格式时 `GetData` 返回 `DV_E_FORMATETC` 并直接 `return`，**不发任何事件**（源码注释原文 *"item is not a file"*） |
| `wry src/webview2/mod.rs:161` | 装了拖放处理器就调 `SetAllowExternalDrop(false)`（注释 *"Disable file drops, so our handler can capture it"*）→ WebView2 自身不再处理外部拖放，**DOM 的 HTML5 `drop` 也一并失效** |
| `tao-0.37.1 .../drop_handler.rs:51-97` | 同样只认 `CF_HDROP` |
| `@tauri-apps/api` `webview.d.ts:22-35` | `DragDropEvent` 只有 `paths: string[]` 与 `position`，**没有任何文本字段** |

**关键推论**：浏览器拖**页面内元素**时，OLE 数据对象里是 `text/plain` / `text/html` / `text/uri-list`，**既不产生 `CF_HDROP`、也不会生成 `.url` 文件**（`.url` 只在拖到桌面/文件系统时由 Explorer 创建）。因此 ADR-092 的读取分支**永远不会被触发**——这解释了为何"改完仍然拖不进去"。

正确参照：用户提供的 [HMCL `AuthlibInjectorDnD`](https://github.com/HMCL-dev/HMCL/blob/77eee17d361996259a48cc7896006a57d2e34a2a/HMCLCore/src/main/java/org/jackhuang/hmcl/auth/authlibinjector/AuthlibInjectorDnD.java#L59) —— 从 `dragboard.getString()`（即 `text/plain`）取文本，再解析 `authlib-injector:yggdrasil-server:` 前缀，与 [authlib-injector 启动器技术规范](https://github.com/yushijinhun/authlib-injector/wiki/%E5%90%AF%E5%8A%A8%E5%99%A8%E6%8A%80%E6%9C%AF%E8%A7%84%E8%8C%83) 一致。

## 决策

新增 `src-tauri/src/dnd.rs`，在 WebView2 子窗口上**自实现 `IDropTarget`**（`RevokeDragDrop` + `RegisterDragDrop` 覆盖 wry 注册的文件专用处理器），同时接受两类数据、且不牺牲文件拖入：

1. `DragEnter` / `DragOver` **只用 `QueryGetData` 探测格式、不取数据**——OLE 协议要求取数留到 `Drop`；早期实现曾在 enter 阶段就 `GetData`+`DragFinish`，等于在拖动过程中就把拖放源的数据消耗掉一次。
2. `Drop` 时**优先**读 `CF_HDROP` → 发 `file-drop`（原有「拖入文件一键安装」语义完全不变）。
3. 否则读 `CF_UNICODETEXT` → 经 `extract_candidate` 过滤 → 发 `ygg-server-drop`。
4. `file-drop-hover` 由本模块补发（接管后 tauri 的 `WindowEvent::DragDrop` 不再触发），拖拽遮罩行为保留。
5. **无需**改 `dragDropEnabled`：直接覆盖子窗口的注册即可，wry 其余行为不受影响。

`extract_candidate` 接受两种形态，并拒绝无关文本（否则任意文本拖拽都会弹确认框）：
- 规范前缀 + `encodeURIComponent` 编码；
- **裸 `http(s)://` 地址** —— issue #136 的 LittleSkin 卡片把地址放在 `data-clipboard-text` 且**不带前缀**，站点不保证遵守规范。

平台依赖用 `windows` / `windows-core` **0.61**（与 tauri 2.x 自身所用版本对齐，避免同进程两套 windows 类型）。整模块 `#[cfg(target_os = "windows")]`；其他平台原本就走 DOM 拖放，不受影响。

**两处安全/健壮性修正**（由 PR #150 审查发现，均属本次新代码的真实缺陷）：
- `extract_candidate` 原用 `raw[..8]` 按**字节**切片判 scheme，对非 ASCII 文本（如「你好世界你好」）会 panic；该函数跑在 COM 的 `Drop` 回调里，panic 无法跨 `extern "system"` 展开 → **拖入任意中文即可终止启动器进程**。改用 `as_bytes()` 比较。
- `read_text` 扫描 NUL 结尾宽字符串无长度上界，畸形/恶意数据会越界读取；改用 `GlobalSize` 限界。

## 备选方案

### 方案 A：设 `dragDropEnabled=false`，让 DOM 的 HTML5 拖放恢复
- 优点：链接拖入立即可用，改动极小
- 缺点：会弄坏「拖入文件一键安装」——DOM 拿不到真实文件路径（这正是 wry 要接管拖放的原因），回归面大
- 为何不选：牺牲已有功能，取舍上不划算（用户明确选择「不牺牲文件拖入」）

### 方案 C：不碰原生拖拽，只做「从剪贴板填入」按钮
- 优点：100% 可控、零原生代码、跨平台一致
- 缺点：不是用户期望的「拖」，卡片拖动体验得不到满足
- 为何不选：对话框本就已有预设按钮 + 输入框可兜底，无需额外加按钮；用户明确要求保留拖拽

## 影响
- src-tauri/src/dnd.rs（新增，含 4 个单测）
- src-tauri/Cargo.toml（windows/windows-core 0.61 平台依赖）
- src-tauri/src/lib.rs（注册 dnd 模块 + setup 中 install；移除 ADR-092 的 .url 解析）
- src/pages/Accounts.tsx（parseYggDndUri 接受裸地址；修正过期注释）
- 取代 ADR-092 中 #136 的决策（其 #138 部分仍有效）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-02 | v1.0 | 初版创建 | AI Agent |