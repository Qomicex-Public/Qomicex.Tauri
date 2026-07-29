# API 端点列表

> 基础 URL: `/api` (Vite 开发代理 → `http://localhost:5000`)

---

## 系统与诊断

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/health` | 基础健康检查 |
| GET | `/api/diagnostics/health` | 诊断健康 (后端 + Modrinth + CurseForge 连通性) |
| GET | `/api/system/info` | 系统信息 (OS、架构、内存、git commit) |
| GET | `/api/diagnostics/trace` | 获取追踪缓冲区快照 |
| POST | `/api/diagnostics/dump` | 转储追踪到文件 |

---

## 设置

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/settings` | 获取应用设置 |
| PUT | `/api/settings` | 保存应用设置 |
| GET | `/api/settings/data-dir` | 获取数据目录路径 |
| PUT | `/api/settings/data-dir` | 设置数据目录路径 |
| POST | `/api/settings/open-folder` | 在文件管理器中打开文件夹 |
| POST | `/api/settings/open-backgrounds` | 打开背景文件夹 |
| GET | `/api/settings/backgrounds` | 列出背景图片 |
| GET | `/api/settings/backgrounds/{name}` | 提供背景图片文件 |
| GET | `/api/settings/download-sources/ping` | Ping 下载镜像 |
| GET | `/api/settings/mod-sources/ping` | Ping Mod 镜像 |
| GET | `/api/settings/download-source/auto-select` | 自动选择最快下载源 |
| GET | `/api/settings/mod-source/auto-select` | 自动选择最快 Mod 源 |

---

## 认证

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| POST | `/api/auth/offline` | 离线模式认证 |
| POST | `/api/auth/microsoft/device-code` | 开始 Microsoft 设备代码流程 |
| POST | `/api/auth/microsoft/poll` | 轮询 Microsoft 登录 |
| POST | `/api/auth/microsoft/info` | 保存 Minecraft 档案 |
| POST | `/api/auth/microsoft/refresh` | 刷新 Microsoft 令牌 |
| POST | `/api/auth/yggdrasil` | Yggdrasil 认证 (外置登录) |
| POST | `/api/auth/yggdrasil/select` | 保存选定 Yggdrasil 档案 |
| POST | `/api/auth/tongyi` | 统一通行证认证 |
| POST | `/api/auth/validate` | 验证访问令牌 |
| POST | `/api/auth/invalidate` | 作废访问令牌 |

---

## 账户

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/account` | 列出所有账户 |
| GET | `/api/account/{uuid}` | 获取特定账户 |
| POST | `/api/account` | 创建/保存账户 |
| DELETE | `/api/account/{uuid}` | 删除账户 |
| GET | `/api/account/default` | 获取默认账户 |
| PUT | `/api/account/{uuid}/default` | 设置默认账户 |
| DELETE | `/api/account/default` | 清除默认账户 |
| GET | `/api/account/lost` | 检查丢失令牌 |
| GET | `/api/account/offline-uuid?name={name}` | MD5 生成离线 UUID |
| GET | `/api/account/yggdrasil-meta?serverUrl={url}` | 获取 Yggdrasil 服务器元数据 |

---

## 版本

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/versions` | 列出远程 Minecraft 版本 |
| GET | `/api/versions/latest` | 获取最新版本信息 |
| GET | `/api/versions/installed` | 列出已安装版本 |
| GET | `/api/versions/remote` | 获取远程版本列表 |
| GET | `/api/versions/scan?gameDir={d}` | 扫描 gameDir 中的版本目录 |
| GET | `/api/versions/{name}` | 获取版本元数据 |
| POST | `/api/versions/{name}/install` | 安装版本 |
| POST | `/api/versions/{name}/uninstall` | 卸载版本 |

---

## 实例

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/instance` | 列出所有实例 |
| GET | `/api/instance/default` | 获取默认实例 |
| PUT | `/api/instance/{id}/default` | 设置默认实例 |
| DELETE | `/api/instance/{id}/default` | 清除默认实例 |
| POST | `/api/instance` | 创建实例 |
| GET | `/api/instance/{id}` | 获取实例详情 |
| PUT | `/api/instance/{id}` | 更新实例 |
| DELETE | `/api/instance/{id}` | 删除实例 |
| POST | `/api/instance/{id}/launch` | 启动实例 |
| GET | `/api/instance/{id}/launch/progress` | 轮询启动进度 |
| POST | `/api/instance/{id}/launch/cancel` | 取消启动 |
| POST | `/api/instance/{id}/install` | 开始安装 (loader + libraries) |
| GET | `/api/instance/{id}/install/progress` | 轮询安装进度 |
| POST | `/api/instance/{id}/install/pause` | 暂停安装 |
| POST | `/api/instance/{id}/install/resume` | 恢复安装 |
| POST | `/api/instance/{id}/install/cancel` | 取消安装 |
| GET | `/api/instance/loaders?gameVersion={v}&type={t}` | 获取可用 Mod Loader 版本 |

---

## 启动

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| POST | `/api/launch` | 直接启动 (高级模式) |
| POST | `/api/launch/{pid}/kill` | 终止游戏进程 |

---

## Java

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/java/search?mode={m}` | 搜索已安装的 Java 运行时 |
| GET | `/api/java/custom` | 列出自定义 Java 路径 |
| POST | `/api/java/custom` | 添加自定义 Java 路径 |
| DELETE | `/api/java/custom` | 移除自定义 Java 路径 |
| GET | `/api/java/list?mode={m}` | 获取合并后的 Java 运行时列表 |
| POST | `/api/java/validate` | 验证 Java 路径 |
| GET | `/api/java/requirement?gameDir={d}&version={v}` | 获取 Java 版本要求 |
| POST | `/api/java/recommended` | 推荐 Java 版本 |
| GET | `/api/java/download/catalog` | 列出可下载的 Java 版本 |
| POST | `/api/java/download/start` | 开始 Java 下载 |
| GET | `/api/java/download/progress/{taskId}` | Java 下载进度 |
| DELETE | `/api/java/download/{taskId}` | 取消 Java 下载 |
| POST | `/api/java/download/{taskId}/pause` | 暂停下载 |
| POST | `/api/java/download/{taskId}/resume` | 恢复下载 |
| GET | `/api/java/download/active` | 获取活跃的 Java 下载 |

---

## Loader

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/loaders/versions?gameVersion={v}&loader={l}` | 获取加载器版本 (支持: All, Forge, Fabric, LegacyFabric, NeoForge, Quilt, LiteLoader, OptiFine, Cleanroom, Babric) |
| GET | `/api/loaders/addons?loader={l}&gameVersion={v}` | 获取加载器扩展 (Fabric API, QSL, OptiFine) |

---

## 资源中心

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/resources/search?source={s}&keyword={k}&...` | 跨平台搜索 Modrinth/CurseForge/FTB |
| GET | `/api/resources/{id}?source={s}` | 资源详情 |
| GET | `/api/resources/{id}/versions?source={s}&...` | 资源版本列表 |
| GET | `/api/resources/{id}/versions/{versionId}/downloads?source={s}` | 版本下载 URL |
| GET | `/api/resources/{id}/dependencies?source={s}&...` | 解析资源依赖树 |
| POST | `/api/resources/{id}/versions/start-fetch` | 开始异步 CF 版本获取 |
| GET | `/api/resources/versions/fetch-progress/{taskId}` | CF 获取进度 |
| GET | `/api/resources/versions/fetch-result/{taskId}` | CF 获取结果 |
| GET | `/api/resources/{id}/translate?source={s}` | 获取资源中文翻译 |
| POST | `/api/resources/translate-text` | 翻译一般文本 |
| POST | `/api/resources/complete` | 补全资源 (检查/安装) |
| GET | `/api/resources/complete/progress` | 补全进度 |

---

## 实例文件

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/instance/{id}/files/mods` | 列出 Mods |
| GET | `/api/instance/{id}/files/mods/count` | Mod 计数 |
| GET | `/api/instance/{id}/files/mods/progress` | Mod 加载进度 |
| GET | `/api/instance/{id}/files/installed-names?category={c}` | 已安装文件名列表 |
| GET | `/api/instance/{id}/files/mods/metadata` | Mod 元数据 (含中文名称) |
| POST | `/api/instance/{id}/files/mods/enable?name={n}` | 启用 Mod |
| POST | `/api/instance/{id}/files/mods/disable?name={n}` | 禁用 Mod |
| DELETE | `/api/instance/{id}/files/mods?name={n}` | 删除 Mod |
| POST | `/api/instance/{id}/files/mods/batch-enable` | 批量启用 |
| POST | `/api/instance/{id}/files/mods/batch-disable` | 批量禁用 |
| POST | `/api/instance/{id}/files/mods/batch-delete` | 批量删除 |
| GET | `/api/instance/{id}/files/resourcepacks` | 列出资源包 |
| GET | `/api/instance/{id}/files/resourcepacks/metadata` | 资源包元数据 |
| DELETE | `/api/instance/{id}/files/resourcepacks?name={n}` | 删除资源包 |
| GET | `/api/instance/{id}/files/shaderpacks` | 列出光影包 |
| GET | `/api/instance/{id}/files/shaderpacks/metadata` | 光影包元数据 |
| DELETE | `/api/instance/{id}/files/shaderpacks?name={n}` | 删除光影包 |
| GET | `/api/instance/{id}/files/datapacks` | 列出数据包 |
| GET | `/api/instance/{id}/files/datapacks/metadata` | 数据包元数据 |
| DELETE | `/api/instance/{id}/files/datapacks?name={n}` | 删除数据包 |
| GET | `/api/instance/{id}/files/screenshots` | 列出截图 |
| GET | `/api/instance/{id}/files/screenshots/metadata` | 截图元数据 |
| GET | `/api/instance/{id}/files/screenshots/{fileName}` | 提供截图图片 |
| DELETE | `/api/instance/{id}/files/screenshots?name={n}` | 删除截图 |
| GET | `/api/instance/{id}/files/saves` | 列出存档 |
| GET | `/api/instance/{id}/files/saves/metadata` | 存档元数据 |
| POST | `/api/instance/{id}/files/saves/copy` | 复制存档 |
| POST | `/api/instance/{id}/files/saves/rename` | 重命名存档 |
| POST | `/api/instance/{id}/files/saves/backup` | 备份存档 |
| DELETE | `/api/instance/{id}/files/saves?name={n}` | 删除存档 |
| GET | `/api/instance/{id}/files/servers` | 列出服务器列表 |
| POST | `/api/instance/{id}/files/servers` | 添加服务器 |
| DELETE | `/api/instance/{id}/files/servers?ip={i}` | 删除服务器 |
| GET | `/api/instance/{id}/files/server-ping?address={a}` | Ping 服务器 |
| GET | `/api/instance/{id}/files/lan-games` | 发现局域网游戏 |
| GET | `/api/instance/{id}/files/options` | 获取游戏设置项列表 |
| GET | `/api/instance/{id}/files/options/{name}` | 获取指定设置项定义 |
| PUT | `/api/instance/{id}/files/options/{name}` | 修改设置项值 |

---

## 资源下载

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| POST | `/api/resource-download/start` | 开始 Mod/Resourcepack 下载 |
| POST | `/api/resource-download/download-to` | 下载到特定路径 |
| GET | `/api/resource-download/{taskId}/progress` | 下载进度 |
| POST | `/api/resource-download/{taskId}/cancel` | 取消下载 |
| POST | `/api/resource-download/cancel-batch` | 批量取消 |

---

## 皮肤

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/skin/profile/{uuid}?type={t}&server={s}` | 获取角色信息 |
| GET | `/api/skin/texture/{uuid}?type={t}&server={s}` | 提供皮肤图片 |
| POST | `/api/skin/upload/{uuid}` | 上传自定义皮肤 |
| DELETE | `/api/skin/upload/{uuid}` | 重置皮肤为默认 |

---

## MCMOD

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/mcmod/lookup?name={n}` | 在 mcmod_data 中查找中文名称 |
| POST | `/api/mcmod/batch` | 批量查找中文名称 |

---

## 日志

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/logs` | 列出日志文件 |
| GET | `/api/logs/export?path={p}` | 下载日志文件 |
| POST | `/api/logs/export-to` | 导出日志到路径 |
| POST | `/api/logs/export-all-to` | 导出所有日志为 zip |
| GET | `/api/logs/export-all` | 下载所有日志 zip |
| DELETE | `/api/logs?path={p}` | 删除日志文件 |
| POST | `/api/logs/open` | 在编辑器中打开日志 |
| POST | `/api/logs/open-dir` | 打开日志目录 |

---

## 日志分析

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| POST | `/api/loganalysis/analyze` | AI 分析日志内容 |
| POST | `/api/loganalysis/analyze-crash/{instanceId}` | 分析崩溃报告 |

---

## 连接器

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| POST | `/api/connector/host/port` | 通过端口开房 |
| POST | `/api/connector/host/instance` | 通过实例开房 |
| POST | `/api/connector/join` | 加入房间 |
| GET | `/api/connector/status` | 连接器状态 |
| GET | `/api/connector/easytier/status` | EasyTier VPN 状态 |
| POST | `/api/connector/easytier/download` | 下载 EasyTier |
| POST | `/api/connector/leave` | 离开房间 |
| GET | `/api/connector/scan-ports` | 扫描 Java 进程端口 |
| GET | `/api/connector/nat-type` | 检测 NAT 类型 |

---

## Modpack

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| POST | `/api/modpack/parse` | 解析上传的 Modpack 文件 |
| POST | `/api/modpack/resolve` | 解析在线 Modpack (CF/MR) |
| POST | `/api/modpack/install` | 安装 Modpack |

---

## 许可证

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/license/status` | 许可证状态 |
| POST | `/api/license/activate` | 激活许可证 |

---

## 公告

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/client/announcements?channel={c}` | 获取公告 (代理到远程) |

---

## 更新

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/update/check?current={v}&channel={c}` | 检查启动器更新 |
| GET | `/api/update/manifest?current={v}&target={t}&arch={a}` | 获取 Tauri 更新 manifest |

---

## 进度 SSE

| 方法 | 路径 | 用途 |
|:---|:---|:---|
| GET | `/api/progress/stream` | SSE 流 (安装/下载进度) |
