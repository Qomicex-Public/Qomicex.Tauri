# 更新日志

## 新增功能

### 崩溃分析对话框
- 新增 `CrashAnalysisDialog` 全局组件，在游戏崩溃时自动弹出分析结果
- 支持 mclo.gs 上传日志并生成二维码，方便分享
- 智能崩溃日志收集：按时间窗口过滤、多源聚合
- 错误模式扩展：OOM 检测、堆栈跨引用分析
- 在 RunningContext 和各页面中集成

### 后台 trace 日志管理
- 新增 `LogController`（5 个端点）：列表/预览/导出/删除/打开
- 自动清理超过 10 条的旧日志文件
- 当前会话标记（创建时间 ±5 秒内）
- 单条 .gz 导出，全部 .zip 导出（Tauri 原生保存对话框）
- 右键菜单支持：打开、打开目录、导出、删除

### 设置页统一与反馈
- 设置页各 tab 统一图标颜色 (`text-primary`) 和卡片布局
- 关于页新增"反馈"按钮，跳转 GitHub Issues
- 后端启动失败页新增"反馈问题"按钮

## Bug 修复
- 修复 Forge 安装器 Linux 上 classpath 分隔符硬编码为 `;` 的问题
- 修复生成版本 JSON 时 `node already has a parent` 异常
- 修复 Windows 构建因移除 Qomicex.Launcher 项目而失败的问题
- 修复崩溃对话框中 mclo.gs form 数据、loading 状态等 review 问题
- 删除 `backend-trace-*` 后日志列表立即刷新

## 重构与优化
- 日志功能范围限定为后端 trace 日志（移除实例日志相关代码）
- 使用后端 API 替代 Tauri `opener` 插件实现打开/打开目录
- 导出改为 POST + JSON body 模式，确保大文件稳定
- 移除 `Directory.Build.props`、`Qomicex.Downloader.Bench`、`Qomicex.Launcher`
- 移除 `docs/superpowers/` 过程文档

## 其他
- 新增 GitHub Issue 模板（bug report）
- `.gitignore` 更新，`README.md` 更新
