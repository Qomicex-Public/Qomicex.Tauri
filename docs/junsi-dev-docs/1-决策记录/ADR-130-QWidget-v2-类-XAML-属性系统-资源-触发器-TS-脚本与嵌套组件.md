# ADR-130：QWidget v2：类 XAML 属性系统、资源/触发器、TS 脚本与嵌套组件

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-11-10 |
| 决策者 | AI Agent |

## 背景

ADR-129 的单文件 XML 组件已支持基础布局/数据/动作，但用户需要更接近 WPF/XAML 的表达力：大驼峰命名、属性元素与附加属性、Resources/Triggers、Data 的 XML/二进制/本地文件、TextBox/Media 等控件、TS 函数脚本、按钮调用函数/命令/插件 API，以及 Widget 嵌套复用。

## 决策

升级为 QWidget v2：所有元素/属性/枚举值改大驼峰；支持 <Tag.Attr> 属性元素与 Grid.Row/Column/Span 附加属性；Data 支持 Json/Text/Xml/Binary（Url/File），二进制经 base64 转 Blob URL，本地路径绝对或相对组件目录/数据目录；新增 Resources（String/Bool/Number/Binary/Resource）与 Triggers（Loaded/DataChanged/Click/Timer）；新增 TextBox/CheckBox/Slider/Select/Progress/Link/Media/FilePicker/ColorPicker；Function 使用 Interface/Input/Output/Script，脚本用 sucrase 剥离 TS 后在 sandbox iframe（CSP 断网、无 DOM/存储/import）执行，只暴露 Input/Inputs/Resources/Data/Results/Host（Notify/OpenUrl/Navigate/Log），默认 3s 超时；动作扩展 CallFunction/RunCommand/PluginApi，参数支持 {Inputs.*}/{Results.*} 绑定；Widget.Using 支持 Name/Url/文本简写、As 别名、Arguments 初始输入，父组件只读 Children.*，远程嵌套沿用 6h TTL 静默更新；RunCommand 走 Tauri IPC（不走 HTTP，避免任意网页调用），PluginApi 调主窗口插件注册表；完全静默更新 + 不限制危险动作按用户选择实现，首次保存危险组件弹风险提示并常驻横幅。编辑器换成懒加载 CodeMirror 6，含行号/高亮/折叠/搜索/Schema 补全/实时 lint，并提供 Function.Script 的独立 TS 页签与试运行。

## 备选方案

### 方案 维持 camelCase + 仅属性写法
- 优点：改动最小
- 缺点：不符合用户要求，也无法表达属性元素/函数脚本
- 为何不选：v2 需要与 XAML 习惯一致

### 方案 主线程 new Function 执行脚本
- 优点：实现最简单
- 缺点：脚本可访问 DOM/localStorage/网络，远程组件等于 RCE
- 为何不选：必须用 sandbox iframe + CSP 隔离

### 方案 只支持 JS，不做 TS 转译
- 优点：不新增 sucrase 依赖
- 缺点：与用户需求不符
- 为何不选：sucrase 体积小且只剥离类型

### 方案 Monaco 编辑器
- 优点：功能最全
- 缺点：体积数 MB、worker 配置重
- 为何不选：CodeMirror 6 已满足行号/高亮/补全/lint

### 方案 嵌套组件导出时递归内联
- 优点：单文件可独立分发
- 缺点：文件膨胀且内联副本不跟随原组件更新
- 为何不选：按用户选择保留 Name/Url 并提示依赖

## 影响
- 重写 src/pages/dashboard/custom/{schema,types,xml,render,actions,store,CustomWidget,WidgetEditorDialog,template}.ts(x)
- 新增 custom/script/{transpile,sandbox,functions}.ts、custom/editor/{CodeEditor.tsx,create-editor.ts}、custom/binary.ts
- 后端 POST /api/widgets/proxy 支持 binary（文本 1MB / 二进制 8MB）
- Tauri 新增 read_widget_binary / run_widget_command（输出 64KB、超时 60s）
- 新增 sucrase + CodeMirror 6 依赖；编辑器懒加载 chunk
- qomicex-tauri-i18n 7 语言补 dashboard.custom.* 风险/编辑器/嵌套文案
- 完全静默更新与不限制 RunCommand/PluginApi 会带来远程代码执行风险；通过风险提示/横幅与 Tauri IPC 边界降低误用，但不构成安全隔离

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-11-10 | v1.0 | 初版创建 | AI Agent |