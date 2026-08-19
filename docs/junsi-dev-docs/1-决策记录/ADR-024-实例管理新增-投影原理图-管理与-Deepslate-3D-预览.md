# ADR-024：实例管理新增「投影原理图」管理与 Deepslate 3D 预览

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-17 |
| 决策者 | AI Agent |

## 背景

用户要求启动器实例详情页新增 Litematica 投影原理图管理，并支持预览（查看投影内容 + 材料列表）。测试文件为真实 v6 .litematic（19×20×18 / 1152 方块 / 40 调色板 / 17 材料），解析算法已在真实文件上验证全等（bad=0、非空=1152）。参考实现 github.com/EndingCredits/litematic-viewer（Deepslate）。

## 决策

前端新增「投影原理图」实例 tab（搜索/打开文件夹/本地导入(multipart,扩展名白名单)/重命名/单删+批量删）。预览采用方案 B：前端用 deepslate 0.26 做 WebGL 3D 渲染 + 材质面板 + Y 层滑块 + 多 region + 容量降级(50万提示/200万材料列表)。解析全放前端（NbtFile 自动解 gzip + 移植参考位解码算法）。材质按原理图调色板子集从用户游戏文件运行时提取（versions/{GameVersion}/{GameVersion}.jar → 版本目录 assets/ → 游戏根 assets/，zip 一次性打开复用，后端磁盘缓存），启动器不捆绑 Mojang 素材（版权合规）。schematics 目录纳入版本隔离（versions/{inst.Name}/schematics，安装时预创建）。

## 备选方案

### 方案 方案A（自建方块色板）
- 优点：无版权风险、依赖少
- 缺点：无官方材质视觉差
- 为何不选：用户选择官方材质方案B

### 方案 方案B*（官方材质,运行时从jar读）
- 优点：视觉最好、不捆绑Mojang素材合规
- 缺点：需后端zip提取+图集前端拼合
- 为何不选：选定

### 方案 deepslate 0.10.1
- 优点：与参考工具同栈、API 1:1
- 缺点：个别方块渲染缺陷
- 为何不选：用户选最新 0.26.0，已适配新 API

## 影响
- 后端: instance_files.rs 新增 schematics 列表/删除/重命名/导入/字节下载/素材提取 6 端点 + 新服务 schematic_assets.rs(含3单测) + install_service 隔离目录加 schematics + installed_names 映射
- 前端: src/lib/litematic.ts(解析) + src/lib/schematic-viewer.ts(渲染) + src/components/SchematicPreviewDialog.tsx + InstanceDetail 投影原理图 tab + api/instance-files.ts 包装 + package.json 新增 deepslate@0.26.0/gl-matrix
- i18n: qomicex-tauri-i18n submodule 7 语言 instanceDetail.ts 加 tab/schematics/preview 键(需单独提交推送submodule)

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-17 | v1.0 | 初版创建 | AI Agent |