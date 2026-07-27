# API 端点列表

> 基础 URL: `/api` (Vite 开发代理 → `http://localhost:5000`)

---

## 系统与诊断

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/health` | 基础健康检查 |
| GET | `/diagnostics/health` | 诊断健康 (后端 + Modrinth + CurseForge 连通性) |
| GET | `/system/info` | 系统信息 (OS、架构、内存、git commit) |
| GET | `/diagnostics/trace` | 获取追踪缓冲区快照 |
| POST | `/diagnostics/dump` | 转储追踪到文件 |

---

## 设置

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/settings` | 获取应用设置 |
| PUT | `/settings` | 保存应用设置 |
| GET | `/settings/data-dir` | 获取数据目录路径 |
| PUT | `/settings/data-dir` | 设置数据目录路径 |
| POST | `/settings/open-folder` | 在文件管理器中打开文件夹 |
| POST | `/settings/open-backgrounds` | 打开背景文件夹 |
| GET | `/settings/backgrounds` | 列出背景图片 |
| GET | `/settings/backgrounds/{name}` | 提供背景图片文件 |
| GET | `/settings/download-sources/ping` | Ping 下载镜像 |
| GET | `/settings/mod-sources/ping` | Ping Mod 镜像 |
| GET | `/settings/download-source/auto-select` | 自动选择最快下载源 |
| GET | `/settings/mod-source/auto-select` | 自动选择最快 Mod 源 |

---

## 认证

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| POST | `/auth/offline` | 离线模式认证 |
| POST | `/auth/microsoft/device-code` | 开始 Microsoft 设备代码流程 |
| POST | `/auth/microsoft/poll` | 轮询 Microsoft 登录 |
| POST | `/auth/microsoft/info` | 保存 Minecraft 档案 |
| POST | `/auth/microsoft/refresh` | 刷新 Microsoft 令牌 |
| POST | `/auth/yggdrasil` | Yggdrasil 认证 (外置登录) |
| POST | `/auth/yggdrasil/select` | 保存选定 Yggdrasil 档案 |
| POST | `/auth/tongyi` | 统一通行证认证 |
| POST | `/auth/validate` | 验证访问令牌 |
| POST | `/auth/invalidate` | 作废访问令牌 |

---

## 账户

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/account` | 列出所有账户 |
| GET | `/account/{uuid}` | 获取特定账户 |
| POST | `/account` | 创建/保存账户 |
| DELETE | `/account/{uuid}` | 删除账户 |
| GET | `/account/default` | 获取默认账户 |
| PUT | `/account/{uuid}/default` | 设置默认账户 |
| DELETE | `/account/default` | 清除默认账户 |
| GET | `/account/lost` | 检查丢失令牌 |
| GET | `/account/offline-uuid` | MD5 生成离线 UUID |
| GET | `/account/yggdrasil-meta` | 获取 Yggdrasil 服务器元数据 |

---

## 版本

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/versions` | 列出远程 Minecraft 版本 |
| GET | `/versions/latest` | 获取最新版本信息 |
| GET | `/versions/installed` | 列出已安装版本 |
| GET | `/versions/remote` | 获取远程版本列表 |
| GET | `/versions/scan` | 扫描 gameDir 中的版本目录 |
| GET | `/versions/{name}` | 获取版本元数据 |
| POST | `/versions/{name}/install` | 安装版本 |
| POST | `/versions/{name}/uninstall` | 卸载版本 |

---

## 实例

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/instance` | 列出所有实例 |
| GET | `/instance/default` | 获取默认实例 |
| PUT | `/instance/{id}/default` | 设置默认实例 |
| DELETE | `/instance/{id}/default` | 清除默认实例 |
| POST | `/instance` | 创建实例 |
| GET | `/instance/{id}` | 获取实例详情 |
| PUT | `/instance/{id}` | 更新实例 |
| DELETE | `/instance/{id}` | 删除实例 |
| POST | `/instance/{id}/launch` | 启动实例 |
| GET | `/instance/{id}/launch/progress` | 轮询启动进度 |
| POST | `/instance/{id}/launch/cancel` | 取消启动 |
| POST | `/instance/{id}/install` | 开始安装 (loader + libraries) |
| GET | `/instance/{id}/install/progress` | 轮询安装进度 |
| POST | `/instance/{id}/install/cancel` | 取消安装 |
| GET | `/instance/loaders` | 获取可用 Mod Loader 版本 |

---

## 启动

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| POST | `/launch` | 直接启动 (高级模式) |
| POST | `/launch/{pid}/kill` | 终止游戏进程 |

---

## Java

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/java/search` | 搜索已安装的 Java 运行时 |
| GET | `/java/custom` | 列出自定义 Java 路径 |
| POST | `/java/custom` | 添加自定义 Java 路径 |
| DELETE | `/java/custom` | 移除自定义 Java 路径 |
| GET | `/java/list` | 获取合并后的 Java 运行时列表 |
| POST | `/java/validate` | 验证 Java 路径 |
| GET | `/java/requirement` | 获取 Java 版本要求 |
| POST | `/java/recommended` | 推荐 Java 版本 |
| GET | `/java/download/catalog` | 列出可下载的 Java 版本 |
| POST | `/java/download/start` | 开始 Java 下载 |
| GET | `/java/download/progress/{taskId}` | Java 下载进度 |
| DELETE | `/java/download/{taskId}` | 取消 Java 下载 |
| POST | `/java/download/{taskId}/pause` | 暂停下载 |
| POST | `/java/download/{taskId}/resume` | 恢复下载 |
| GET | `/java/download/active` | 获取活跃的 Java 下载 |

---

## Loader

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/loaders/versions` | 获取加载器版本 (支持: All, Forge, Fabric, LegacyFabric, NeoForge, Quilt, LiteLoader, OptiFine, Cleanroom) |
| GET | `/loaders/addons` | 获取加载器扩展 (Fabric API, QSL, OptiFine) |

---

## 资源中心

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/resources/search` | 搜索 Modrinth/CurseForge/FTB |
| GET | `/resources/{id}` | 资源详情 |
| GET | `/resources/{id}/versions` | 资源版本 |
| GET | `/resources/{id}/versions/{versionId}/downloads` | 版本下载 URL |
| GET | `/resources/{id}/dependencies` | 解析的依赖 |
| POST | `/resources/{id}/versions/start-fetch` | 开始异步 CF 版本获取 |
| GET | `/resources/versions/fetch-progress/{taskId}` | CF 获取进度 |
| GET | `/resources/versions/fetch-result/{taskId}` | CF 获取结果 |
| GET | `/resources/{id}/translate` | 获取资源中文翻译 |
| POST | `/resources/translate-text` | 翻译一般文本 |
| POST | `/resources/complete` | 补全资源 (检查/安装) |
| GET | `/resources/complete/progress` | 补全进度 |

---

## 实例文件

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/instance/{id}/files/mods` | 列出 Mods |
| GET | `/instance/{id}/files/mods/count` | Mod 计数 |
| GET | `/instance/{id}/files/mods/progress` | Mod 加载进度 |
| GET | `/instance/{id}/files/installed-names` | 已安装文件名 |
| GET | `/instance/{id}/files/mods/metadata` | Mod 元数据 (含中文名称) |
| POST | `/instance/{id}/files/mods/enable` | 启用 Mod |
| POST | `/instance/{id}/files/mods/disable` | 禁用 Mod |
| DELETE | `/instance/{id}/files/mods` | 删除 Mod |
| POST | `/instance/{id}/files/mods/batch-enable` | 批量启用 |
| POST | `/instance/{id}/files/mods/batch-disable` | 批量禁用 |
| POST | `/instance/{id}/files/mods/batch-delete` | 批量删除 |
| GET | `/instance/{id}/files/resourcepacks` | 列出资源包 |
| GET | `/instance/{id}/files/resourcepacks/metadata` | 资源包元数据 |
| DELETE | `/instance/{id}/files/resourcepacks` | 删除资源包 |
| GET | `/instance/{id}/files/shaderpacks` | 列出光影包 |
| GET | `/instance/{id}/files/shaderpacks/metadata` | 光影包元数据 |
| DELETE | `/instance/{id}/files/shaderpacks` | 删除光影包 |
| GET | `/instance/{id}/files/datapacks` | 列出数据包 |
| GET | `/instance/{id}/files/datapacks/metadata` | 数据包元数据 |
| DELETE | `/instance/{id}/files/datapacks` | 删除数据包 |
| GET | `/instance/{id}/files/screenshots` | 列出截图 |
| GET | `/instance/{id}/files/screenshots/metadata` | 截图元数据 |
| GET | `/instance/{id}/files/screenshots/{fileName}` | 提供截图图片 |
| DELETE | `/instance/{id}/files/screenshots` | 删除截图 |
| GET | `/instance/{id}/files/saves` | 列出存档 |
| GET | `/instance/{id}/files/saves/metadata` | 存档元数据 |
| POST | `/instance/{id}/files/saves/copy` | 复制存档 |
| POST | `/instance/{id}/files/saves/rename` | 重命名存档 |
| POST | `/instance/{id}/files/saves/backup` | 备份存档 |
| DELETE | `/instance/{id}/files/saves` | 删除存档 |
| GET | `/instance/{id}/files/servers` | 列出服务器 |
| POST | `/instance/{id}/files/servers` | 添加服务器 |
| DELETE | `/instance/{id}/files/servers` | 删除服务器 |
| GET | `/instance/{id}/files/server-ping` | Ping 服务器 |
| GET | `/instance/{id}/files/lan-games` | 发现局域网游戏 |
| GET | `/instance/{id}/files/options` | 获取游戏设置 |
| GET | `/instance/{id}/files/options/{name}` | 获取特定设置 |
| PUT | `/instance/{id}/files/options/{name}` | 更新设置 |

---

## 资源下载

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| POST | `/resource-download/start` | 开始 Mod/Resourcepack 下载 |
| POST | `/resource-download/download-to` | 下载到特定路径 |
| GET | `/resource-download/{taskId}/progress` | 下载进度 |
| POST | `/resource-download/{taskId}/cancel` | 取消下载 |
| POST | `/resource-download/cancel-batch` | 批量取消 |

---

## 皮肤

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/skin/profile/{uuid}` | 获取角色信息 |
| GET | `/skin/texture/{uuid}` | 提供皮肤图片 |
| POST | `/skin/upload/{uuid}` | 上传自定义皮肤 |
| DELETE | `/skin/upload/{uuid}` | 重置皮肤为默认 |

---

## MCMOD

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/mcmod/lookup` | 在 mcmod_data 中查找中文名称 |
| POST | `/mcmod/batch` | 批量查找中文名称 |

---

## 日志

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/logs` | 列出日志文件 |
| GET | `/logs/export` | 下载日志文件 |
| POST | `/logs/export-to` | 导出日志到路径 |
| POST | `/logs/export-all-to` | 导出所有日志为 zip |
| GET | `/logs/export-all` | 下载所有日志 zip |
| DELETE | `/logs` | 删除日志文件 |
| POST | `/logs/open` | 在编辑器中打开日志 |
| POST | `/logs/open-dir` | 打开日志目录 |

---

## 连接器

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| POST | `/connector/host/port` | 托管特定端口 |
| POST | `/connector/host/instance` | 托管实例 |
| POST | `/connector/join` | 加入房间 |
| GET | `/connector/status` | 连接器状态 |
| GET | `/connector/easytier/status` | EasyTier VPN 状态 |
| POST | `/connector/easytier/download` | 下载 EasyTier |
| POST | `/connector/leave` | 离开房间 |
| GET | `/connector/scan-ports` | 扫描 Minecraft 端口 |
| GET | `/connector/nat-type` | 检测 NAT 类型 |

---

## Modpack

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| POST | `/modpack/parse` | 解析上传的 Modpack 文件 |
| POST | `/modpack/resolve` | 解析在线 Modpack (CF/MR) |
| POST | `/modpack/install` | 安装 Modpack |

---

## 许可证

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/license/status` | 许可证状态 |
| POST | `/license/activate` | 激活许可证 |

---

## 其他

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/client/announcements` | 获取公告 (代理到远程) |
| GET | `/update/check` | 检查启动器更新 |
| GET | `/progress/stream` | SSE 流 (安装/下载进度) |
