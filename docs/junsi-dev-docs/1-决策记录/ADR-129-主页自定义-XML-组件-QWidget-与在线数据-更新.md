# ADR-129：主页自定义 XML 组件（QWidget）与在线数据/更新

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-11-10 |
| 决策者 | AI Agent |

## 背景

issue #135 要求像 PCL 一样自定义主页组件。现有主页已是 react-grid-layout 网格（ADR-065），支持拖动/缩放/隐藏与插件槽组件，但用户无法直接创建组件。用户希望用类似 XAML 的 XML 描述结构、绑定内置动作，并支持在线导入与数据更新。

## 决策

新增单文件 .qwidget（XML）组件格式：白名单元素 Container/Row/Column/Grid/Tabs/TabItem/List/ListItem/Text/Button/Image/Divider/Spacer/If/Data；字符串绑定 {path}，多数据源按 name 绑定；Button 仅可绑定 10 个内置动作（launch/setDefaultInstance/openInstance/navigate/openUrl/openFolder/copy/selectAccount/install/refresh）。渲染在前端完成，外部 XML 与数据统一经后端 POST /api/widgets/proxy 抓取：仅 https:443、禁重定向、解析后钉住公网 IP、512KB/15s 上限。组件定义与数据缓存存 localStorage（qomicex.dashboard.customWidgets.v1 / qomicex.dashboard.customWidgetData.v1），布局沿用 ADR-065 的 custom:<uuid> 条目。导入/保存时用户必须逐项确认自动出网域名；在线组件按 6h TTL 静默检查更新，新增未确认域名时不替换并标记待确认。安装动作只跳转资源详情页。

## 备选方案

### 方案 复用 .qplugin/WASM 插件体系
- 优点：已有沙箱、权限与槽位
- 缺点：作者需写 JS/WASM 与 manifest，门槛高，与 XAML 式表达不符
- 为何不选：自定义主页组件应让普通用户写 XML 即可

### 方案 远程 HTML iframe
- 优点：表达力最强、实现最简单
- 缺点：XSS/钓鱼面不可控，样式无法与启动器一致
- 为何不选：不可信远程内容不应获得 HTML 执行能力

### 方案 WebView 直连外部 https（不经后端）
- 优点：少一个端点
- 缺点：CORS 大部分数据源不可用，SSRF/体积/超时无法集中防护
- 为何不选：后端代理可统一安全边界

### 方案 组件与数据存后端文件/设置
- 优点：跨设备、无 localStorage 配额
- 缺点：需要新增 Rust 持久化类型与迁移，ADR-065 已确定展示偏好走 localStorage
- 为何不选：单文件 XML ≤64KB，localStorage 足够

## 影响
- 新增 src-backend/qomicex-backend/src/endpoints/widgets.rs（POST /api/widgets/proxy）与 SSRF/体积/超时测试
- 新增 src/pages/dashboard/custom/*（schema/xml/types/render/actions/store/CustomWidget/WidgetEditorDialog/template）
- src-tauri dialog_cmd.rs 新增 read_widget_file / write_widget_file（仅 .qwidget/.xml，≤256KB）
- Dashboard/WidgetGrid/context 接入 custom:<uuid> 条目与编辑器入口
- qomicex-tauri-i18n 7 语言新增 dashboard.custom.* 键（子模块单独提交）
- 新增 scripts/test-widget-schema.mjs + package.json test:widget-schema
- 残余风险：远程组件可改变界面文案（无 JS/表单，不能采集凭据）；静默更新不弹窗，新增数据域名必须重新确认

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-11-10 | v1.0 | 初版创建 | AI Agent |