# API 端点参考

> 更新日期：2026-08-16

后端基础地址：`http://localhost:5000`。前端 Vite 代理将 `/api/*` 转发到此地址。

所有未捕获异常按统一错误格式返回（详见底部"错误格式"章节）。

---

## 目录

- [账号 Account](#1-账号-account)
- [认证 Auth](#2-认证-auth)
- [公告 Announcement](#3-公告-announcement)
- [联机 Connector](#4-联机-connector)
- [实例 Instance](#5-实例-instance)
- [实例文件 Instance Files](#6-实例文件-instance-files)
- [Java 运行时](#7-java-运行时)
- [启动 Launch](#8-启动-launch)
- [许可证 License](#9-许可证-license)
- [加载器 Loader](#10-加载器-loader)
- [日志 Log](#11-日志-log)
- [中文名 Mcmod](#12-中文名-mcmod)
- [整合包 Modpack](#13-整合包-modpack)
- [插件 Plugin](#14-插件-plugin)
- [进度 SSE](#15-进度-sse-stream)
- [资源中心 Resource Center](#16-资源中心-resource-center)
- [资源下载 Resource Download](#17-资源下载-resource-download)
- [资源补全 Resource Complete](#18-资源补全-resource-complete)
- [皮肤 Skin](#19-皮肤-skin)
- [系统 System](#20-系统-system)
- [更新 Update](#21-更新-update)
- [版本 Version](#22-版本-version)

---

## 1. 账号 Account

**分组前缀：** `/api/account`

### GET `/api/account`

列出所有已保存的账号。

**响应：** `List<StoredAccount>`

### GET `/api/account/{uuid}`

获取指定账号详情。

| 参数 | 类型 | 位置 | 说明 |
|------|------|------|------|
| uuid | string | path | 账号 UUID |

**响应：** `StoredAccount`

### POST `/api/account`

保存/更新账号。

**请求体：** `StoredAccount`

**响应：** `StoredAccount`

### DELETE `/api/account/{uuid}`

删除指定账号。

| 参数 | 类型 | 位置 | 说明 |
|------|------|------|------|
| uuid | string | path | 账号 UUID |

**响应：** `204 No Content`

### GET `/api/account/default`

获取默认账号。

**响应：** `StoredAccount` 或 `404`

### PUT `/api/account/{uuid}/default`

设为默认账号。

| 参数 | 类型 | 位置 | 说明 |
|------|------|------|------|
| uuid | string | path | 账号 UUID |

**响应：** `StoredAccount`

### DELETE `/api/account/default`

清除默认账号。

**响应：** `204 No Content`

### GET `/api/account/lost`

检查是否所有账号都已丢失。

**响应：** `{ "lost": bool }`

### GET `/api/account/offline-uuid?name={name}`

根据离线玩家名生成 UUID。

| 参数 | 类型 | 位置 | 说明 |
|------|------|------|------|
| name | string | query | 玩家名，必填 |

**响应：** `{ "uuid": "..." }`

### GET `/api/account/yggdrasil-meta?serverUrl={serverUrl}`

查询 Yggdrasil 认证服务器元信息。

| 参数 | 类型 | 位置 | 说明 |
|------|------|------|------|
| serverUrl | string | query | 认证服务器 URL |

**响应：** `{ "serverName": "..." }`

---

## 2. 认证 Auth

**分组前缀：** `/api/auth`

### POST `/api/auth/offline`

离线模式登录。

**请求体：**
```json
{ "username": "Player", "mode": "offline" }
```

**响应：** `AuthResponse`

### POST `/api/auth/microsoft/device-code`

开始 Microsoft 设备码登录流程。

**响应：** `AuthResponse`（包含 `deviceCode`, `userCode`, `verificationUri`）

### POST `/api/auth/microsoft/poll`

轮询 Microsoft 登录状态。

```json
{ "accessToken": "deviceCode" }
```

| 字段 | 类型 | 说明 |
|------|------|------|
| accessToken | string | 上一步返回的 deviceCode |

**响应：** `AuthResponse`

### POST `/api/auth/microsoft/info`

通过 Microsoft token 获取 Minecraft 档案并保存账号。

```json
{ "accessToken": "...", "refreshToken": "..." }
```

**响应：** `StoredAccount`

### POST `/api/auth/microsoft/refresh`

刷新 Microsoft 账号 Token。

```json
{ "accountUuid": "..." }
```

**响应：** `MicrosoftRefreshResponse`

### POST `/api/auth/yggdrasil`

Yggdrasil 认证登录。

```json
{
  "username": "...",
  "password": "...",
  "serverUrl": "https://littleskin.cn/api/yggdrasil"
}
```

**响应：** `YggdrasilProfilesResponse`

### POST `/api/auth/yggdrasil/select`

选择 Yggdrasil 档案并保存账号。

```json
{
  "accessToken": "...",
  "clientToken": "...",
  "serverUrl": "...",
  "selectedProfiles": [{ "id": "...", "name": "..." }]
}
```

**响应：** `List<StoredAccount>`

### POST `/api/auth/tongyi`

统一通行证登录（通义/网易等）。

```json
{ "serverId": "...", "email": "...", "password": "..." }
```

**响应：** `StoredAccount`

### POST `/api/auth/validate`

验证 Token 有效性。

```json
{ "accessToken": "..." }
```

**响应：** `{ "valid": bool }`

### POST `/api/auth/invalidate`

作废 Token。

```json
{ "accessToken": "..." }
```

**响应：** `{ "message": "Token invalidated" }`

---

## 3. 公告 Announcement

### GET `/api/client/announcements?channel={channel}`

获取启动器公告。

| 参数 | 类型 | 位置 | 说明 |
|------|------|------|------|
| channel | string | query | 可选，公告频道 |

**响应：** `List<AnnouncementDto>`

---

## 4. 联机 Connector

**分组前缀：** `/api/connector`

### POST `/api/connector/host/port`

指定端口开房。

```json
{ "port": 25565 }
```

**响应：** `{ "roomCode": "...", "status": null, "error": null }`

### POST `/api/connector/host/instance`

基于实例开房。

```json
{ "instanceId": "..." }
```

**响应：** `{ "roomCode": null, "status": "hosting", "error": null }`

### POST `/api/connector/join`

加入房间。

```json
{ "code": "ABCD" }
```

**响应：** `{ "mcHost": "...", "mcPort": 25565 }`

### GET `/api/connector/status`

获取联机状态。

**响应：** `ConnectorStatusDto`

### GET `/api/connector/easytier/status`

获取 EasyTier 下载状态。

**响应：** `EasyTierDownloadStatus`

### POST `/api/connector/easytier/download`

触发 EasyTier 下载。

**响应：** `EasyTierDownloadStatus`

### POST `/api/connector/leave`

离开房间/停止联机。

**响应：** `{ "status": "idle" }`

### GET `/api/connector/scan-ports`

扫描 Java 端口。

**响应：** `{ "port": int | null }`

### GET `/api/connector/nat-type`

检测 NAT 类型。

**响应：** `NatTypeResult`

---

## 5. 实例 Instance

**分组前缀：** `/api/instance`

### GET `/api/instance`

获取所有实例。

**响应：** `List<GameInstance>`

### GET `/api/instance/default`

获取默认实例（ID）。

**响应：** `GameInstance` 或 `204 No Content`

### PUT `/api/instance/{id}/default`

设为默认实例。

**响应：** `GameInstance`

### DELETE `/api/instance/{id}/default`

清除默认实例。

**响应：** `204 No Content`

### POST `/api/instance`

创建实例。

**请求体：**
```json
{
  "name": "My Instance",
  "gameVersion": "1.20.1",
  "loader": "forge",
  "loaderVersion": "47.1.0",
  "javaPath": null,
  "maxMemory": 4096,
  "gameDir": ".minecraft"
}
```

**响应：** `GameInstance` (201 Created)

### GET `/api/instance/{id}`

获取实例详情。

**响应：** `GameInstance`

### PUT `/api/instance/{id}`

更新实例。所有字段可选。

```json
{
  "name": "...",
  "gameVersion": "...",
  "loader": "...",
  "loaderVersion": "...",
  "javaPath": "...",
  "maxMemory": 4096,
  "jvmArgs": "...",
  "isHidden": false,
  "versionIsolation": true
}
```

**响应：** `GameInstance`

### DELETE `/api/instance/{id}`

删除实例。

**响应：** `{ "message": "Instance xxx deleted" }` 或 `404`

### GET `/api/instance-groups`

实例自定义分组列表。

**响应：** `[{ "id": "4a7b375a-d72", "name": "建筑服", "color": "#22c55e" }]`

### POST `/api/instance-groups`

创建自定义分组。

**请求体：** `{ "name": "建筑服", "color": "#22c55e" }`（name 空/重名 → 400）

**响应：** `InstanceGroup`

### PUT `/api/instance-groups/{id}`

重命名 / 改色自定义分组。

**请求体：** `{ "name": "新名称", "color": "#3b82f6" }`（与其他分组重名 → 400）

**响应：** `InstanceGroup`

### DELETE `/api/instance-groups/{id}`

删除自定义分组，并清理所有实例对该分组的引用（`customGroupIds`）。

**响应：** `{ "message": "Group xxx deleted" }` 或 `404`

### POST `/api/instance/{id}/launch`

启动实例（异步）。

**请求体（可选）：**
```json
{
  "joinServer": "...",
  "joinWorld": "...",
  "accountUuid": "..."
}
```

**响应：** `LaunchResultDto` (`stage: "starting"`)

启动进度通过 `GET /api/instance/{id}/launch/progress` 轮询。

### GET `/api/instance/{id}/launch/progress`

轮询启动进度。

**响应：** `LaunchProgressDto`

### POST `/api/instance/{id}/launch/cancel`

取消启动。

**响应：** `{ "message": "..." }`

### POST `/api/instance/{id}/install`

触发实例安装（下载 Minecraft 版本/加载器/附加组件）。

```json
{
  "loader": "forge",
  "loaderVersion": "47.1.0",
  "addons": ["fabric-api"],
  "optifineVersion": null,
  "downloadThreads": 64,
  "versionIsolation": true,
  "downloadSourceId": 0
}
```

**响应：** `{ "message": "Install started for xxx" }`

### GET `/api/instance/{id}/install/progress`

轮询安装进度。

**响应：** `InstallProgressResponse`

### POST `/api/instance/{id}/install/pause`

暂停安装。

**响应：** `{ "message": "..." }`

### POST `/api/instance/{id}/install/resume`

恢复安装。

**响应：** `{ "message": "..." }`

### POST `/api/instance/{id}/install/cancel`

取消安装。

**响应：** `{ "message": "..." }`

### GET `/api/instance/loaders?gameVersion={version}&type={type}`

获取可用加载器列表。

| 参数 | 类型 | 位置 | 说明 |
|------|------|------|------|
| gameVersion | string | query | MC 版本，必填 |
| type | string | query | 可填 fabric / forge / neoforge / quilt / cleanroom / babric 等 |

**响应：** `List<LoaderVersionInfo>`

---

## 6. 实例文件 Instance Files

**分组前缀：** `/api/instance/{id}/files`

以下所有端点需要实例 ID。

### Mods

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/mods` | 列出模组文件 |
| GET | `/mods/count` | 模组数量（含 .disabled） |
| GET | `/mods/progress` | 模组元数据加载进度 |
| GET | `/mods/metadata` | 模组元数据（名称、版本、描述、图标、CF/MR ID） |
| GET | `/installed-names?category=mods` | 已安装文件名列表 |
| POST | `/mods/enable?name=...` | 启用模组 |
| POST | `/mods/disable?name=...` | 禁用模组 |
| DELETE | `/mods?name=...` | 删除模组 |
| POST | `/mods/batch-enable` | 批量启用 `["a.jar","b.jar"]` |
| POST | `/mods/batch-disable` | 批量禁用 |
| POST | `/mods/batch-delete` | 批量删除 |
| GET | `/mods/check-updates?force=0\|1` | 模组更新检查（批次哈希匹配，独立 6h 缓存；`force=1` 强制联网，返回 `{updates, refreshed}`） |
| GET | `/mods/update-cache` | 只读读取更新检查缓存 `{updates, stale}`（前端列表加载后据此决定是否联网检查） |
| DELETE | `/mods/update-cache` | 删除该实例的更新检查磁盘缓存（更新成功后调用，避免下次自动检查返回过期条目） |

### Resourcepacks

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/resourcepacks` | 列出资源包 |
| GET | `/resourcepacks/metadata` | 资源包元数据 |
| DELETE | `/resourcepacks?name=...` | 删除资源包 |

### Shaderpacks

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/shaderpacks` | 列出光影包 |
| GET | `/shaderpacks/metadata` | 光影包元数据 |
| DELETE | `/shaderpacks?name=...` | 删除光影包 |

### DataPacks

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/datapacks` | 列出数据包 |
| GET | `/datapacks/metadata` | 数据包元数据 |
| DELETE | `/datapacks?name=...` | 删除数据包 |

### Screenshots

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/screenshots` | 列出截图 |
| GET | `/screenshots/metadata` | 截图元数据 |
| GET | `/screenshots/{fileName}` | 获取截图文件（image/png） |
| DELETE | `/screenshots?name=...` | 删除截图 |

### Saves

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/saves` | 列出存档 |
| GET | `/saves/metadata` | 存档元数据（含图标 base64） |
| POST | `/saves/copy` | 复制存档 `{ "name": "...", "newName": "..." }` |
| POST | `/saves/rename` | 重命名存档 `{ "oldName": "...", "newName": "..." }` |
| POST | `/saves/backup?name=...` | 备份存档 |
| DELETE | `/saves?name=...` | 删除存档 |
| GET | `/saves/{name}/settings` | 读取存档设置（level.dat NBT 精选字段；level.dat 缺失 → 404） |
| PUT | `/saves/{name}/settings` | 更新存档设置（写前自动备份 level.dat.qomicex.bak，失败回滚；返回最新值） |
| POST | `/saves/{name}/settings/restore` | 从 level.dat_old 恢复存档设置（_old 缺失 → 404） |

### Servers

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/servers` | 服务器列表 |
| POST | `/servers` | 添加服务器 `{ "name": "...", "ip": "..." }` |
| DELETE | `/servers?ip=...` | 删除服务器 |
| GET | `/server-ping?address=...` | Ping 服务器 |
| GET | `/lan-games` | 发现局域网游戏 |

### Options

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/options` | 获取游戏设置列表（中文） |
| GET | `/options/{name}` | 获取单项设置定义 |
| PUT | `/options/{name}` | 修改设置 `{ "value": "..." }` |

**响应模型 `FileEntryDto`：**
```json
{
  "name": "filename.jar",
  "size": 12345,
  "lastModified": "2026-01-01T00:00:00",
  "created": "2026-01-01T00:00:00",
  "isDirectory": false,
  "extension": ".jar"
}
```

---

## 7. Java 运行时

**分组前缀：** `/api/java`

### GET `/api/java/search?mode={mode}`

搜索系统 Java 运行时。

| 参数 | 类型 | 说明 |
|------|------|------|
| mode | string | `quick`（默认）或 `deep` |

**响应：** `List<JavaRuntimeInfo>`

### GET `/api/java/custom`

获取用户自定义 Java 列表。

### POST `/api/java/custom`

添加自定义 Java 路径。

```json
{ "path": "C:\\Program Files\\Java\\jdk-17\\bin\\javaw.exe" }
```

### DELETE `/api/java/custom`

删除自定义 Java。

```json
{ "path": "..." }
```

### GET `/api/java/list?mode={mode}`

获取合并后的 Java 列表（系统扫描 + 自定义）。

### POST `/api/java/validate`

验证 Java 路径是否有效。

```json
{ "path": "..." }
```

**响应：** `JavaRuntimeInfo`

### GET `/api/java/requirement?gameDir={dir}&version={version}`

获取版本所需的 Java 主版本号。

**响应：** `{ "requiredMajorVersion": 17 }`

### POST `/api/java/recommended`

获取推荐 Java。

```json
{ "minecraftVersion": "1.20.1", "gameDir": ".minecraft" }
```

**响应：** `JavaRuntimeInfo`

### `/api/java/download` 子分组

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/download/catalog` | 获取可下载 Java 版本目录 |
| POST | `/download/start` | 开始下载 Java `{ "vendor": "temurin\|zulu", "version": 17, "platform": "windows", "architecture": "x64" }`，后台管线 queued→resolving→downloading→extracting→registering→completed，完成后自动注册运行时 |
| GET | `/download/progress/{taskId}` | 查询下载进度 |
| DELETE | `/download/{taskId}` | 取消下载 |
| POST | `/download/{taskId}/pause` | 暂停下载 |
| POST | `/download/{taskId}/resume` | 恢复下载 |
| GET | `/download/active` | 获取所有活跃下载状态 |

---

## 8. 启动 Launch

**分组前缀：** `/api/launch`

### POST `/api/launch`

直接启动（不通过实例管理）。

```json
{
  "instanceId": "...",
  "versionId": "1.20.1-Forge-47.1.0",
  "javaPath": "C:\\java\\bin\\javaw.exe",
  "maxMemory": 4096,
  "jvmArgs": "-XX:+UseG1GC",
  "versionIsolation": false,
  "authUuid": "...",
  "authName": "Player",
  "authToken": "...",
  "joinServer": "localhost",
  "joinWorld": "world"
}
```

**响应：** `LaunchResultDto`

### POST `/api/launch/{pid}/kill`

通过进程 ID 强制结束游戏进程。

| 参数 | 类型 | 说明 |
|------|------|------|
| pid | int | path，进程 ID |

**响应：** `{ "message": "..." }`

---

## 9. 许可证 License

**分组前缀：** `/api/license`

### GET `/api/license/status`

查询许可证状态。

**响应：** `LicenseStatusResponse`
```json
{
  "valid": true,
  "machineCode": "...",
  "licenseId": "...",
  "channel": "stable",
  "expireAt": "...",
  "isPermanent": false,
  "error": null
}
```

### POST `/api/license/activate`

激活许可证。

```json
{ "licenseToken": "..." }
```

**响应：** `LicenseActivateResponse`

---

## 10. 加载器 Loader

**分组前缀：** `/api/loaders`

### GET `/api/loaders/versions?gameVersion={v}&loader={type}`

获取某加载器可用版本列表。

| 参数 | 类型 | 说明 |
|------|------|------|
| gameVersion | string | 必填 |
| loader | string | 默认 `All`，可选 Fabric/Forge/NeoForge/Quilt 等 |

**响应：** `List<LoaderVersionInfo>`

### GET `/api/loaders/addons?loader={type}&gameVersion={v}`

获取加载器推荐附加组件（如 Fabric API、OptiFine、QSL）。

**响应：** `List<LoaderAddonInfo>`

---

## 11. 日志 Log

**分组前缀：** `/api/logs`

### GET `/api/logs`

列出日志文件。

**响应：** `List<LogEntry>`

### GET `/api/logs/export?path={base64EncodedPath}`

下载单个日志文件。

### POST `/api/logs/export-to`

导出日志到指定路径。

```json
{ "path": "...", "dest": "..." }
```

### POST `/api/logs/export-all-to`

打包所有日志到指定路径。

```json
{ "dest": "C:\\logs.zip" }
```

### GET `/api/logs/export-all`

直接下载所有日志的 zip 包。

### DELETE `/api/logs?path={path}`

删除日志文件。

### POST `/api/logs/open`

用系统默认程序打开日志文件。

```json
{ "path": "..." }
```

### POST `/api/logs/open-dir`

用文件管理器打开日志所在目录。

```json
{ "path": "..." }
```

### GET `/api/logs/content?path={path}`

读取日志文件内容（前端查看器用）。只允许 logs 目录内文件；超大文件截断尾部 2MB。

**响应：**
```json
{ "path": "...", "content": "...", "truncated": false }
```

### POST `/api/logs/frontend`

前端 console 日志上报（构建版 Tauri 无控制台时仍可查看/落盘）。

```json
{ "level": "warn", "message": "..." }
```

写入 trace 缓冲 + `qomicex-backend.log`（前缀 `[frontend:level]`），返回 204。

---

## 12. 中文名 Mcmod

**分组前缀：** `/api/mcmod`

### GET `/api/mcmod/lookup?name={name}`

查询模组中文名。

**响应：** `{ "cnName": "..." }` （null 表示未找到）

### POST `/api/mcmod/batch`

批量查询中文名。

```json
["JEI", "OptiFine", "Sodium"]
```

**响应：** `{ "JEI": "JEI物品管理器", "OptiFine": "光影优化", "Sodium": "钠" }`

---

## 13. 整合包 Modpack

**分组前缀：** `/api/modpack`

### POST `/api/modpack/parse`

上传并解析整合包文件（.zip / .mrpack），为本地导入的第一步。

`multipart/form-data`，字段名 `file`（上限 4 GiB）。

支持格式探测：含 `modrinth.index.json` → Modrinth（mr）；含 `manifest.json`（`manifestType=minecraftModpack`）→ CurseForge（cf）；两者皆无 → `MODPACK_PARSE_FAILED`(400)。

文件保存到 `{BaseDir}/temp/modpack-uploads/{uuid}`（1 天后自动清理），响应带 `fileId` 句柄供 `/install` 传回复用，安装结束后删除。

**响应：** `ModpackParseResult`

```json
{
  "name": "TestPack",
  "summary": "...",
  "author": "...",
  "version": "1.0.0",
  "gameVersion": "1.20.1",
  "loader": "forge",
  "loaderVersion": "47.1.0",
  "source": "modrinth",
  "files": [{ "path": "mods/x.jar", "downloadUrl": "https://..." }],
  "hasOverrides": true,
  "fileCount": 10,
  "fileId": "1ed395be-..."
}
```

**错误码：** `MODPACK_PARSE_FILE_REQUIRED`(400)、`MODPACK_PARSE_UPLOAD_FAILED`(400)、`MODPACK_PARSE_TOO_LARGE`(400)、`MODPACK_PARSE_FAILED`(400)

### POST `/api/modpack/resolve`

从在线源获取整合包信息。

```json
{
  "source": "modrinth",
  "projectId": "...",
  "versionId": "..."
}
```

### POST `/api/modpack/install`

开始安装整合包。本地导入时传 `fileId`（parse 返回）即可复用已上传文件：管道跳过包体下载，mr 按 URL 下载 mods、cf 按 manifest `projectID:fileID` 查 CF API 逐文件下载，随后从本地 zip 释放 overrides（overrides 是 API 找不到的文件）。

```json
{
  "source": "curseforge",
  "projectId": 12345,
  "versionId": 67890,
  "name": "My Pack",
  "gameDir": ".minecraft",
  "fileId": "1ed395be-..."
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | 实例名 |
| `gameVersion` | ✅ | 游戏版本 |
| `gameDir` | ✅ | 实例根目录 |
| `versionIsolation` | ✅ | 版本隔离 |
| `loader`/`loaderVersion` | 条件 | 加载器（本地导入由 parse 结果带出） |
| `source` | 条件 | `modrinth` / `curseforge` / `ftb`；本地导入必传（驱动 mods 下载与 overrides 释放） |
| `fileId` | 条件 | 本地导入：`/parse` 返回的临时文件句柄 |
| `modpackFiles` | 条件 | 解析出的文件清单（本地导入传 parse 结果的 files） |

**响应：** `{ "message": "安装已启动", "versionId": "..." }`

### POST `/api/modpack/install-direct`

一键安装整合包（插件/内部调用用）。与 `/install` 共享完整安装管线：后端自行解析来源并组装安装请求，调用方只需传定位信息。

```json
{
  "id": "MyPack",
  "type": "mr",
  "projectId": "abc",
  "fileId": "123",
  "gameDir": "C:/games/instances"
}
```

本地导入：`path` 传服务器端绝对路径（.zip / .mrpack），后端同步解析 + 后台安装（同 `/parse` 的格式探测与管道本地分支）。

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 实例名（同步为版本目录名） |
| `gameDir` | ✅ | 实例所在根目录 |
| `type` | 条件 | 在线来源：`mr`/`modrinth`、`cf`/`curseforge`、`ftb` |
| `projectId` | 条件 | 在线来源的项目 id（与 `fileId` 成对） |
| `fileId` | 条件 | 在线来源的版本 id |
| `path` | 条件 | 本地整合包路径（.zip / .mrpack），与 `type+projectId+fileId` 二选一 |
| `versionIsolation` | ❌ | 版本隔离，默认 `false` |
| `maxMemory` | ❌ | 默认 `4096` |

**响应：** `{ "instanceId": "..." }`（安装异步进行，进度走下载中心 / SSE）

**错误码：** `MODPACK_NAME_REQUIRED`(400)、`MODPACK_GAME_DIR_REQUIRED`(400)、`MODPACK_FILE_NOT_FOUND`(404)、`MODPACK_SOURCE_REQUIRED`(400)、`MODPACK_SOURCE_INVALID`(400)、`MODPACK_PARSE_FAILED`(400)

### POST `/api/modpack/export/{instanceId}`

把已安装实例导出为整合包：`cf`（CurseForge zip，`manifest.json` + `overrides/`）或 `mr`（Modrinth mrpack，`modrinth.index.json` + `overrides/`）。同步生成，响应 `Content-Disposition: attachment` 的 zip 字节。

```json
{ "format": "cf", "includeSaves": false, "includeScreenshots": false }
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `format` | ✅ | `cf`/`curseforge`/`zip` 或 `mr`/`modrinth`/`mrpack` |
| `includeSaves` | ❌ | 是否含 `saves`，默认 `false` |
| `includeScreenshots` | ❌ | 是否含 `screenshots`，默认 `false` |

导出内容：
- 源目录 = `{gameDir}/versions/{inst.name}`（版本隔离）或 `{gameDir}`；排除版本 json/jar、`libraries/versions/assets/logs/temp/crash-reports`、账户缓存（`usercache.json` 等）与未勾选的 `saves`/`screenshots`。
- **CF zip**：mods 用 CF fingerprint（32 位 MurmurHash2，种子 1、乘数 1540483477、忽略空白字节 9/10/13/32）反查 `POST /v1/fingerprints` 得 `projectID/fileID` 写入 `manifest.json` 的 `files[]`；mods 同时留在 `overrides/mods`（CF 惯例双份）。
- **mrpack**：mods 用 SHA1 反查 `POST v2/version_files` 得下载 URL/哈希/大小写入 `modrinth.index.json` 的 `files[]`；已解析 mods 不再进 overrides。
- 反查为 best-effort：失败（离线/无 key/限流）只影响 `files[]`，mods 回落 `overrides/mods`，导出不中断。

**错误码：** `MODPACK_EXPORT_INSTANCE_NOT_FOUND`(404)、`MODPACK_EXPORT_FORMAT_INVALID`(400)

---

## 14. 插件 Plugin

**分组前缀：** `/api/plugins`

### GET `/api/plugins`

列出所有插件。

**响应：** `List<PluginInfo>`

### GET `/api/plugins/{id}`

获取插件详情。

### POST `/api/plugins/rescan`

重新扫描插件目录。

**响应：** `{ "scanned": 5 }`

### POST `/api/plugins/install`

从目录安装插件。

```json
{ "sourceDir": "/path/to/plugin" }
```

### DELETE `/api/plugins/{id}`

卸载插件。

**响应：** `204 No Content`

### POST `/api/plugins/upload`

上传 .qplugin 包安装。

`multipart/form-data`，字段名 `plugin`。

### PUT `/api/plugins/{id}/state`

设置插件状态。

```json
{ "state": "active" }
```

state 可选：`installed` / `active` / `disabled`

### GET `/api/plugins/{id}/files/{*path}`

获取插件静态文件（HTML/JS/CSS/图片等）。

按 MIME 类型返回：`.css` → `text/css`, `.js` → `application/javascript`, `.html` → `text/html`, 图片 → 对应类型

### GET `/api/plugins/settings/{id}`

获取插件设置。

### POST `/api/plugins/settings/{id}`

保存插件设置。

```json
{ "key": "value", ... }
```

### POST `/api/plugins/cache/{id}`

写入插件缓存。需要插件声明 `cache:access` 权限。

```json
{ "key": "models", "value": { "list": [] }, "ttlSeconds": 3600 }
```

| 字段 | 类型 | 说明 |
|------|------|------|
| key | string | 必填，缓存键（≤512 字符） |
| value | json | 必填，任意 JSON 值 |
| ttlSeconds | int | 可选，过期秒数；不传为永久缓存 |

**响应：** `200`

### GET `/api/plugins/cache/{id}?key={key}`

读取插件缓存。key 不存在或已过期返回 `{ "value": null }`。

**响应：** `{ "value": <json> | null }`

### POST `/api/plugins/proxy`

CORS 代理：插件网页 fetch 外部 API 被 CORS 拒绝时，由后端转发请求绕开限制。需要插件声明 `network:cors_proxy` 权限。

```json
{
  "url": "https://api.example.com/data",
  "method": "GET",
  "headers": { "X-Test": "hello" },
  "body": null,
  "timeoutMs": 15000
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| url | string | 必填，目标 URL（仅 http/https） |
| method | string | 默认 GET |
| headers | object | 自定义请求头 |
| body | string | 请求体（POST/PUT/PATCH） |
| timeoutMs | int | 默认 15000，范围 1000–60000 |

**响应：** `{ "status": 200, "headers": {...}, "body": "文本内容", "bodyBase64": null }`

文本/JSON 响应走 `body`，二进制走 `bodyBase64`。**SSRF 防护**：禁内网/保留地址、不自动跟随重定向。错误码：`PROXY_INVALID_URL`(400)、`PROXY_SCHEME_NOT_ALLOWED`(400)、`PROXY_PRIVATE_ADDRESS`(400)、`PROXY_UPSTREAM_FAILED`(502)。

---

## 15. 进度 SSE Stream

### GET `/api/progress/stream`

SSE (Server-Sent Events) 实时进度流。每 300ms 推送一次。

**Content-Type:** `text/event-stream`

**事件格式：**
```
data: {"type":"progress","installs":[...],"javaDownloads":[...],"resources":[...],"summary":{"activeCount":3,"totalSpeed":12345.6}}
```

包含所有活跃的安装任务、Java 下载和资源下载的汇总状态。

---

## 16. 资源中心 Resource Center

**分组前缀：** `/api/resources`

### GET `/api/resources/search?source={src}&keyword={k}&page={p}&pageSize={s}&gameVersion={v}&loader={l}&category={c}&sort={sort}`

跨平台搜索资源（Modrinth / CurseForge / FTB）。

| 参数 | 类型 | 说明 |
|------|------|------|
| source | string | `modrinth`（默认）、`curseforge`、`ftb` |
| keyword | string | 搜索关键词 |
| page | int | 页码，从 1 开始 |
| pageSize | int | 每页条数 |
| gameVersion | string | 筛选 MC 版本 |
| loader | string | 筛选加载器 |
| category | string | 类别：`mod`、`modpack`、`resourcepack`、`shader`、`datapack` |
| sort | string | `relevance`、`downloads`、`updated`、`newest` |

**响应：** `ResourceSearchResponse`

### GET `/api/resources/{id}?source={src}`

获取资源详情。

**响应：** `ResourceDetailDto`

### GET `/api/resources/{id}/versions?source={src}&gameVersion={v}&loader={l}`

获取资源版本列表。

**响应：** `List<ResourceVersionDto>`

### GET `/api/resources/{id}/versions/{versionId}/downloads?source={src}`

获取某版本的下载链接。

**响应：** `List<ResourceFileDto>`

### GET `/api/resources/{id}/dependencies?source={src}&versionId={v}&gameVersion={gv}&loader={l}`

递归解析依赖树。

**响应：** `List<ResolvedDependencyDto>`

### GET `/api/resources/ftb/{projectId}/export`

获取 FTB 整合包完整版本详情。

### POST `/api/resources/{id}/versions/start-fetch`

启动 CurseForge 版本列表异步拉取。

```json
{ "gameVersion": "1.20.1", "loader": "forge" }
```

**响应：** `{ "taskId": "...", "totalVersionCount": 0, "loadedVersionCount": 0 }`

### GET `/api/resources/versions/fetch-progress/{taskId}`

查询拉取进度。

### GET `/api/resources/versions/fetch-result/{taskId}`

获取拉取结果。

### GET `/api/resources/{id}/translate?source={src}`

获取资源的中文翻译（来自 mcimirror）。

### POST `/api/resources/translate-text`

翻译文本。

```json
{ "text": "Hello" }
```

**响应：** `{ "original": "Hello", "translated": "你好", "translatedAt": null }`

---

## 17. 资源下载 Resource Download

**分组前缀：** `/api/resource-download`

### POST `/api/resource-download/start`

开始下载资源到实例目录。

```json
{
  "instanceId": "...",
  "url": "https://...",
  "fileName": "mod.jar",
  "category": "mods",
  "targetPath": null
}
```

`category` 可选：`mods`、`resourcepacks`、`shaderpacks`、`datapacks`、`saves`、`screenshots`

**响应：** `{ "taskId": "...", "fileName": "..." }`

### POST `/api/resource-download/download-to`

下载到指定路径。

```json
{ "url": "...", "targetPath": "C:\\dest\\file.jar" }
```

### GET `/api/resource-download/{taskId}/progress`

查询下载进度。

**响应：** `DownloadProgressResponse`

### POST `/api/resource-download/{taskId}/cancel`

取消下载。

### POST `/api/resource-download/cancel-batch`

批量取消。

```json
{ "taskIds": ["id1", "id2"] }
```

---

## 18. 资源补全 Resource Complete

### POST `/api/resources/complete`

补全/安装指定的 Minecraft 版本资源。

```json
{ "versionId": "1.20.1", "checkOnly": false }
```

`checkOnly: true` 时仅检查是否已安装。

### GET `/api/resources/complete/progress`

查询补全进度。

---

## 19. 皮肤 Skin

**分组前缀：** `/api/skin`

### GET `/api/skin/profile/{uuid}?type={type}&server={server}`

获取玩家皮肤档案。

| 参数 | 类型 | 说明 |
|------|------|------|
| uuid | string | path |
| type | string | `Microsoft`（默认）或 `Offline` |
| server | string | Yggdrasil 服务器地址 |

**响应：** `SkinProfile`

### GET `/api/skin/texture/{uuid}?type={type}&server={server}`

获取皮肤图片（返回 `image/png`）。

### POST `/api/skin/upload/{uuid}`

上传自定义皮肤。

`multipart/form-data`，字段名 `file`。

### DELETE `/api/skin/upload/{uuid}`

重置为默认皮肤。

---

## 20. 系统 System

**分组前缀：** `/api`

### GET `/api/health`

健康检查。

**响应：** `{ "status": "OK", "timestamp": "..." }`

### GET `/api/diagnostics/health`

详细健康检查（后端 + Modrinth + CurseForge）。

### GET `/api/system/info`

系统信息。`osDisplayName` 为友好的操作系统显示名：
- Windows：读注册表 `ProductName`（sysinfo 自动把 "Windows 10 " 前缀映射为 Windows 11），如 `Windows 11 Pro`
- macOS：`MacOS <版本> <代号>`，如 `MacOS 14.5 Sonoma`
- Linux：`/etc/os-release` 的 `PRETTY_NAME`，如 `Ubuntu 24.04.1 LTS`

**响应：** `SystemInfoResponse`
```json
{
  "os": "windows",
  "architecture": "x86_64",
  "osName": "Windows_NT",
  "osVersion": "Windows NT",
  "osVersionId": "unknown",
  "osDisplayName": "Windows 11 Pro",
  "gitCommit": "abc123",
  "memory": 17179869184,
  "availableMemory": 8589934592
}
```

### GET `/api/systeminfo`

同上（别名）。

### GET `/api/diagnostics/trace`

获取追踪缓冲区快照。

### POST `/api/diagnostics/dump`

导出诊断转储。

**响应：** `{ "path": "..." }`

### GET `/api/settings`

获取启动器设置。

**响应：** `SettingsResponse`（30+ 字段，详见模型定义）

### PUT `/api/settings`

保存启动器设置。

**请求体：** `SettingsResponse`（接受全部或部分字段）

**响应：** `204 No Content`

### GET `/api/settings/data-dir`

获取数据目录路径。

### PUT `/api/settings/data-dir`

修改数据目录。

```json
{ "path": "D:\\Qomicex" }
```

### POST `/api/settings/open-folder`

用文件管理器打开目录。

```json
{ "path": "C:\\..." }
```

### POST `/api/settings/open-backgrounds`

打开背景图片目录。

### GET `/api/settings/backgrounds`

列出背景图片文件名。

### GET `/api/settings/backgrounds/{name}`

获取背景图片（image/png）。

### GET `/api/settings/download-sources/ping`

测试各下载源延迟。

**响应：** `List<DownloadSourcePing>`

### GET `/api/settings/mod-sources/ping`

测试各 Mod 源延迟。

### GET `/api/settings/download-source/auto-select`

自动选择最优下载源。

### GET `/api/settings/mod-source/auto-select`

自动选择最优 Mod 源。

---

## 21. 更新 Update

### GET `/api/update/check?current={v}&channel={c}`

检查启动器更新。

| 参数 | 类型 | 说明 |
|------|------|------|
| current | string | 当前版本号 |
| channel | string | 可选，更新频道 |

**响应：** `UpdateCheckResponse`

### GET `/api/update/manifest?current={v}&target={t}&arch={a}`

获取 Tauri 更新清单。

| 参数 | 类型 | 说明 |
|------|------|------|
| current | string | 当前版本号 |
| target | string | 目标平台，如 `windows-x86_64` |
| arch | string | 架构 |

通过 header `X-Updater-Channel` 指定频道。

**响应：** `TauriManifestResponse`

---

## 22. 版本 Version

**分组前缀：** `/api/versions`

### GET `/api/versions?forceRefresh={bool}`

获取可用 Minecraft 版本列表。

### GET `/api/versions/latest?forceRefresh={bool}`

获取最新版本信息。

### GET `/api/versions/installed`

获取已安装的版本。

### GET `/api/versions/remote?source={int}`

获取远程版本列表。

### GET `/api/versions/scan?gameDir={dir}`

扫描指定目录下的已安装版本，自动修复实例的 `gameVersion` 和 `loader`。

**响应：** `ScanVersionsResponse`

### GET `/api/versions/{name}`

获取版本元数据（完整 version JSON）。

### POST `/api/versions/{name}/install`

安装版本。

**响应：** `{ "message": "...", "versionId": "..." }`

### POST `/api/versions/{name}/uninstall`

卸载版本。

---

## 核心数据模型

### GameInstance

```json
{
  "id": "abc123def456",
  "name": "My Instance",
  "gameVersion": "1.20.1",
  "loader": "forge",
  "loaderVersion": "47.1.0",
  "javaPath": null,
  "maxMemory": 4096,
  "gameDir": ".minecraft",
  "accountName": null,
  "accountUuid": null,
  "accessToken": null,
  "jvmArgs": null,
  "lastPlayed": "2026-07-30T12:00:00",
  "playTime": 3600,
  "isHidden": false,
  "versionIsolation": true,
  "isDefault": false,
  "icon": null,
  "iconData": null,
  "modpackName": null,
  "modpackVersion": null,
  "modpackAuthor": null,
  "modpackSummary": null,
  "skipIntegrityCheck": false,
  "resolvedGameDir": null
}
```

### AuthResponse

```json
{
  "success": true,
  "username": "Player",
  "accessToken": "...",
  "uuid": "...",
  "userType": "offline",
  "errorMessage": null,
  "refreshToken": null,
  "deviceCode": null,
  "userCode": null,
  "verificationUri": null,
  "interval": null,
  "expiresIn": null,
  "isPending": null
}
```

### LaunchProgressDto

```json
{
  "stage": "checking",
  "message": "正在检查文件完整性...",
  "progress": 5.0,
  "isRunning": false,
  "processId": null,
  "exitCode": null,
  "error": null,
  "crashReport": null,
  "missingFiles": ["libraries/.../foo.jar"],
  "arguments": null,
  "currentFile": "libraries/.../bar.jar",
  "totalFiles": 42,
  "completedFiles": 10
}
```

---

## 错误格式

所有未捕获异常统一返回：

```json
{
  "code": "ERROR_CODE",
  "message": "人类可读错误描述",
  "detail": "详细技术信息（可选）",
  "traceId": "abc-123",
  "timestamp": "2026-07-31T12:00:00Z",
  "status": 500
}
```

常见 HTTP 状态码映射：

| 异常类型 | HTTP 状态码 |
|---------|-----------|
| `ApiException.BadRequest` | 400 |
| `ApiException.NotFound` | 404 |
| `FileNotFoundException` | 404 |
| `ArgumentNullException` | 400 |
| `HttpRequestException` | 502 |
| `TaskCanceledException` | 499 |
| `JsonException` | 400 |
| 其他未处理异常 | 500 |


### 2026-08-09 更新
# API 端点参考

> 更新日期：2026-08-09

后端基础地址：`http://localhost:5000`（绑定 127.0.0.1，`QOMICEX_PORT` 可覆盖）。前端 Vite 代理将 `/api/*` 转发到此地址。

**当前后端**：Rust Axum 0.8（`src-backend/qomicex-backend/`）。自 ADR-004 起为唯一主后端，C# 版 `Qomicex.Launcher.Backend.Neo` 保留在 `legacy` 分支。

**状态图例**：
- ✅ 已实现
- ⚠️ **501** — 路由已注册但返回 `501 NOT_IMPLEMENTED`（stub，等待服务移植）
- 🚫 未移植 — C# 版有、Rust 版尚未实现

**缺失模块**：🚫 `Plugin`（/api/plugins* 全部，含 wasm/download/files/shell/proxy/cache）、🚫 `Connector`（/api/connector* 全部）。

所有未捕获异常按统一错误格式返回（详见底部"错误格式"章节）。

---

## 目录

- [账号 Account](#1-账号-account)
- [认证 Auth](#2-认证-auth)
- [公告 Announcement](#3-公告-announcement)
- [联机 Connector](#4-联机-connector)
- [实例 Instance](#5-实例-instance)
- [实例文件 Instance Files](#6-实例文件-instance-files)
- [Java 运行时](#7-java-运行时)
- [启动 Launch](#8-启动-launch)
- [许可证 License](#9-许可证-license)
- [加载器 Loader](#10-加载器-loader)
- [日志 Log](#11-日志-log)
- [中文名 Mcmod](#12-中文名-mcmod)
- [整合包 Modpack](#13-整合包-modpack)
- [插件 Plugin](#14-插件-plugin)
- [进度 SSE](#15-进度-sse-stream)
- [资源中心 Resource Center](#16-资源中心-resource-center)
- [资源下载 Resource Download](#17-资源下载-resource-download)
- [资源补全 Resource Complete](#18-资源补全-resource-complete)
- [皮肤 Skin](#19-皮肤-skin)
- [系统 System](#20-系统-system)
- [更新 Update](#21-更新-update)
- [版本 Version](#22-版本-version)



### 2026-08-09 更新
## 4. 联机 Connector

> 🚫 **未移植**：本节为 C# 版（legacy 分支）端点，Rust 后端尚未实现 `/api/connector*`（对应 Rust crate `qomicex-connector-rust` 尚未接入）。

**分组前缀：** `/api/connector`



### 2026-08-09 更新
## 14. 插件 Plugin

> 🚫 **未移植**：本节为 C# 版（legacy 分支）端点，Rust 后端尚未实现 `/api/plugins*`（upload/files/settings/cache/proxy/wasm/download/shell 等全部端点）。插件系统详细规范见《插件系统 API》文档。

**分组前缀：** `/api/plugins`



### 2026-08-09 更新
### POST `/api/instance/{id}/launch`

> ⚠️ **501 stub**：Rust 后端已注册路由但未实现（等待 LaunchTracker 移植），返回 `501 NOT_IMPLEMENTED`。

启动实例（异步）。



### 2026-08-09 更新
### GET `/api/instance/{id}/launch/progress`

> ⚠️ **501 stub**：Rust 后端未实现，返回 `501 NOT_IMPLEMENTED`。

轮询启动进度。

**响应：** `LaunchProgressDto`

### POST `/api/instance/{id}/launch/cancel`

> ⚠️ **501 stub**：Rust 后端未实现，返回 `501 NOT_IMPLEMENTED`。

取消启动。



### 2026-08-09 更新
### Servers

> ⚠️ **501 stub**：Rust 后端未实现（servers/lan-games/server-ping 全部返回 501）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/servers` | 服务器列表 |
| POST | `/servers` | 添加服务器 `{ "name": "...", "ip": "..." }` |
| DELETE | `/servers?ip=...` | 删除服务器 |
| GET | `/server-ping?address=...` | Ping 服务器 |
| GET | `/lan-games` | 发现局域网游戏 |

### Options

> ⚠️ **501 stub**：Rust 后端未实现（依赖 per-instance OptionsProvider，尚未移植）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/options` | 获取游戏设置列表（中文） |
| GET | `/options/{name}` | 获取单项设置定义 |
| PUT | `/options/{name}` | 修改设置 `{ "value": "..." }` |



### 2026-08-09 更新
### POST `/api/resources/{id}/versions/start-fetch`

> ⚠️ **501 stub**：Rust 后端未实现（CurseForge 异步版本拉取未移植）。

启动 CurseForge 版本列表异步拉取。

### GET `/api/resources/versions/fetch-progress/{taskId}`

> ⚠️ **501 stub**：Rust 后端未实现，返回 `501 NOT_IMPLEMENTED`。

查询拉取进度。

### GET `/api/resources/versions/fetch-result/{taskId}`

> ⚠️ **501 stub**：Rust 后端未实现，返回 `501 NOT_IMPLEMENTED`。

获取拉取结果。



### 2026-08-09 更新
# API 端点参考

> 更新日期：2026-08-09

后端基础地址：`http://localhost:5000`（绑定 127.0.0.1，`QOMICEX_PORT` 可覆盖）。前端 Vite 代理将 `/api/*` 转发到此地址。

**当前后端**：Rust Axum 0.8（`src-backend/qomicex-backend/`）。自 ADR-004 起为唯一主后端，C# 版 `Qomicex.Launcher.Backend.Neo` 保留在 `legacy` 分支。

**状态图例**：
- ✅ 已实现
- ⚠️ **501** — 路由已注册但返回 `501 NOT_IMPLEMENTED`（stub，等待服务移植）
- 🚫 未移植 — C# 版有、Rust 版尚未实现

**缺失模块**：🚫 `Connector`（/api/connector* 全部，对应 Rust crate `qomicex-connector-rust` 尚未接入）。

所有未捕获异常按统一错误格式返回（详见底部"错误格式"章节）。



### 2026-08-09 更新
## 14. 插件 Plugin

**分组前缀：** `/api/plugins`（Rust `src-backend/qomicex-backend/src/endpoints/plugin.rs`，✅ 已实现）



### 2026-08-09 更新
## 4. 联机 Connector

> 🚫 **未移植**：本节为 C# 版（legacy 分支）端点，Rust 后端尚未实现 `/api/connector*`（对应 Rust crate `qomicex-connector-rust` 尚未接入 `app.rs`）。

**分组前缀：** `/api/connector`



### 2026-08-09 更新
### POST `/api/instance/{id}/launch`

启动实例（异步）。



### 2026-08-09 更新
### GET `/api/instance/{id}/launch/progress`

轮询启动进度。

**响应：** `LaunchProgressDto`

### POST `/api/instance/{id}/launch/cancel`

取消启动。



### 2026-08-09 更新
### POST `/api/resources/{id}/versions/start-fetch`

启动 CurseForge 版本列表异步拉取。

```json
{ "gameVersion": "1.20.1", "loader": "forge" }
```

**响应：** `{ "taskId": "...", "totalVersionCount": 0, "loadedVersionCount": 0 }`

### GET `/api/resources/versions/fetch-progress/{taskId}`

查询拉取进度。

### GET `/api/resources/versions/fetch-result/{taskId}`

获取拉取结果。



### 2026-08-12 更新
> **修订（2026-08-12）—— `/api/connector/host/instance` 与 `/api/connector/leave` 行为：**

### POST `/api/connector/host/instance`

基于实例开房（异步，立即返回 `status: "starting"`）。

```json
{ "instanceId": "..." }
```

**响应：** `{ "status": "starting", "message": null, "error": null }`

**启动进度/失败语义（Rust 重写后）：**
- 启动与建房在后台任务执行，进度写入 `LaunchTracker`（复用 `/api/instance/{id}/launch/progress` 轮询）：`starting` →（完整性/环境/启动）→ `running`（游戏已启动，正在检测局域网端口）→ 建房成功 `mode=host`。
- 启动失败：立即写 `failed` 阶段（`error` 含原因）+ `mode=idle` 复位，**不再白等端口轮询 60s**。
- 60s 内未检测到局域网端口 / 建房失败：写 `failed` 阶段 + `mode=idle`。

### POST `/api/connector/leave`

离开房间/停止联机。**Starting 阶段调用时会经 LaunchTracker 杀掉正在启动/已启动的游戏进程**（置取消信号 + kill + 清进度），后台端口轮询检测到取消后放弃建房。



### 2026-08-12 更新
> **修订（2026-08-12）—— 踢人端点：**

### POST `/api/connector/kick`

房主手动踢出指定 guest（仅 host 模式；踢房主自己返回 400 `CONNECTOR_KICK_SELF`，非 host 返回 400 `CONNECTOR_NOT_HOST`）。

```json
{ "machineId": "..." }
```

**响应：** `{ "status": "kicked" }`

**踢出语义（三层断开，`services::kick::KickManager`，经 connector 拓展接口实现）：**
1. **easytier**：`disconnect_peer(easytier_id)` 关闭该玩家全部虚拟网络连接（非 QML SCF 客户端不受 Scaffolding 协议控制，仅此手段；对方若持续在线可能自动重连——fork 无控制面 deny）
2. **Scaffolding TCP**：`ClientRegistry::disconnect_machine` 按 machine_id 定向取消连接令牌（QML guest 心跳失败后整体退出）
3. **玩家列表**：`remove_player` 移除 + 头像映射清理

依赖：`qomicex-connector-rust` rev `1207d45`（踢人能力）；easytier fork `EasyTier4QML` rev `8fccc86`（`PeerManager::close_peer` / `Easytier::disconnect_peer` 全断连接 API）。

**状态响应**：`ConnectorPlayer` 增加 `machineId` 字段（踢出按钮按 machineId 调用）。

### 2026-08-14 修订 —— 踢人语义升级（非 QML guest 可踢除）

> 取代上文「踢出语义（三层断开）」：`services::kick::KickManager` 现为**断开 + 黑名单**四步（**实现位于调用方 backend**，connector 仅提供拓展接口 `set_player_ping_handler` / 能力方法）：

1. **easytier peer 解析 + `deny_peer` 持久物理封禁**（2026-08-16 起由 `disconnect_peer` 升级）：优先已上报 `easytier_id`；未上报（不支持 `c:player_easytier_id` 的第三方 guest）时按 hostname `scaffolding-mc-guest-{machine_id前8位}`（Qomicex 系约定）或 SCF TCP 源虚拟 IP（`TcpServer::machine_source_ip` → `get_nodes()` 反查）定位 peer 后 `deny_peer`（入控制面黑名单 + 立即断连；对方入站/出站连接在建立处被拒，自动重连/重启也连不上——fork rev 9055aef+）。解析失败打 warn（可见性），不再静默跳过。
2. **已踢黑名单**：machine_id 记入 `kicked` 集合（含解析到的 peer id）。被踢 guest 再发 `c:player_ping` → 拒绝入列 + 响应状态 255（不刷新心跳 → 15s 心跳超时兜底剔除）+ 重复断开 SCF TCP 与 easytier。
3. **Scaffolding TCP**：`ClientRegistry::disconnect_machine` 按 machine_id 定向断开（找不到连接打 warn）。
4. **玩家列表**：`remove_player` 移除 + 头像映射清理。

**残余限制**：easytier fork 无控制面 deny，被踢 guest 的 easytier 连接仍会自动重连（黑名单在 SCF 层拦截其重新入列并重复断开 peer）；彻底封禁需给 fork 加控制面 deny（待办）。上游实现：`qomicex-connector-rust`（踢人黑名单 + peer 反查）。

### 2026-08-16 修订 —— 重连审核弹窗（允许/拒绝/拒绝且不再提示）

> 取代上文第 2 步「被踢 guest 再发 c:player_ping → 拒绝入列 + 状态 255」的**一律拒绝**语义：被踢玩家重连时，房主可人工放行（防误踢）。

- **GET `/connector/status`** 响应新增 `pendingKickReviews: [{ machineId, name, vendor }]`（仅 host 模式；`services::kick::KickManager::pending_reviews`）与 `kickedPlayers: [{ machineId, name, vendor }]`（已踢黑名单全量，前端"已踢玩家管理"解除 deny 用；`KickManager::kicked_players`）。
- **POST `/connector/kick/review`** `{ "machineId": "...", "action": "allow" | "reject" | "reject_silent" }`（仅房主）：
  - `allow`：`allow_peer` 解除 easytier deny + 从已踢黑名单移除 → 下一次 `c:player_ping` 正常入列；
  - `reject`：维持踢出，断开其等待中的 SCF TCP + easytier，下次重连可再次询问；
  - `reject_silent`：同 reject 并置 `prompt_disabled` → 后续重连静默拒绝（响应 255），不再弹窗。
- **被踢重连状态机**：首次 re-ping → 置 `pending`（记录玩家名/厂商），响应**状态 0** 保持 SCF TCP 连接（不刷新入列逻辑，玩家不入列），easytier 持续断开（数据面封禁）；重复 ping 不重复弹窗。弹窗关闭（Esc/遮罩/X）= `reject`。
- 前端：`Connect.tsx` 轮询 status 发现 `pendingKickReviews` 非空 → Dialog 三选，逐条处理。

## 2026-08-13 修订：Servers 端点已实现（不再 501）

上方 "### Servers" 一节标注的 "501 stub：servers/lan-games/server-ping 全部返回 501" 已失效，现全部由 Rust 后端真实实现（`src-backend/qomicex-backend/src/endpoints/instance_files.rs`，C# MapServerEndpoints → Rust 迁移）：

| 方法 | 路径 | 说明 | 实现 |
|------|------|------|------|
| GET | `/servers` | 服务器列表（OldServerEntryDto[]：name/ip/iconBase64?/acceptTextures，ip 映射自 ServerEntry.address） | list_servers |
| POST | `/servers` | 添加服务器 `{ "name": "...", "ip": "..." }`，缺字段 400；写入时 AcceptTextures=true → 200 | add_server |
| DELETE | `/servers?ip=...` | 删除服务器 → 204 NoContent | delete_server |
| GET | `/server-ping?address=...` | Ping 服务器，ServerState camelCase 直通（isOnline/ping/onlinePlayers/maxPlayers/version/description/errorMessage/iconBase64），address 必填否则 400 | server_ping |
| GET | `/lan-games` | 发现局域网游戏（5s 超时），LanServerEntry[] 直通（motd/address/port/displayAddress） | lan_games |

实现基于 core 的 `LocalResourcesFactory::create_server_manager(version, version_specific)`（qomicex-core-rust 6278009 / ADR-007）。Options 系列端点仍为 501 stub（依赖尚未移植的 per-instance OptionsProvider）。



### 2026-08-15 更新
### GET `/api/system/info`

系统信息。`osDisplayName` 为友好的操作系统显示名：
- Windows：读注册表 `ProductName`（sysinfo 自动把 "Windows 10 " 前缀映射为 Windows 11），如 `Windows 11 Pro`
- macOS：`MacOS <版本> <代号>`，如 `MacOS 14.5 Sonoma`
- Linux：`/etc/os-release` 的 `PRETTY_NAME`，如 `Ubuntu 24.04.1 LTS`

**响应：** `SystemInfoResponse`
```json
{
  "os": "windows",
  "architecture": "x86_64",
  "osName": "Windows_NT",
  "osVersion": "Windows NT",
  "osVersionId": "unknown",
  "osDisplayName": "Windows 11 Pro",
  "gitCommit": "abc123",
  "memory": 17179869184,
  "availableMemory": 8589934592
}
```


### 2026-08-15 更新
### GET `/api/system/info`

系统信息。`osDisplayName` 为友好的操作系统显示名：
- Windows：读注册表 `ProductName`（sysinfo 自动把 "Windows 10 " 前缀映射为 Windows 11），如 `Windows 11 Pro`
- macOS：`MacOS <版本> <代号>`，如 `MacOS 14.5 Sonoma`
- Linux：`/etc/os-release` 的 `PRETTY_NAME`，如 `Ubuntu 24.04.1 LTS`

**响应：** `SystemInfoResponse`
```json
{
  "os": "windows",
  "architecture": "x86_64",
  "osName": "Windows_NT",
  "osVersion": "Windows NT",
  "osVersionId": "unknown",
  "osDisplayName": "Windows 11 Pro",
  "gitCommit": "abc123",
  "memory": 17179869184,
  "availableMemory": 8589934592
}
```

### 2026-08-16 更新：Yggdrasil ALI 地址解析端点

### POST `/api/account/yggdrasil-resolve`

Yggdrasil 外置登录的 **ALI（API 地址指示）** 解析：把用户输入的缩略地址解析为完整 API 根地址。实现遵循 [authlib-injector 启动器技术规范](https://yushijinhun.github.io/authlib-injector/zh/%E5%90%AF%E5%8A%A8%E5%99%A8%E6%8A%80%E6%9C%AF%E8%A7%84%E8%8C%83.html)。

**请求体：**
```json
{ "url": "littleskin.cn" }
```

| 字段 | 类型 | 说明 |
|------|------|------|
| url | string | 用户输入的地址；可缺省协议（自动补 `https://`）、可为完整 API 根 |

**解析规则：**
1. 无协议 → 补 `https://`（不降级到明文 http）；
2. GET 该地址（跟随 HTTP 重定向）；
3. 响应含 `X-Authlib-Injector-API-Location` 头 → 该头指向 API 根（相对地址基于最终响应 URL 解析；指向自身则视为当前地址即 API 根）；
4. 无该头 → 当前（规范化后的输入）地址即 API 根。

**响应：** `{ "apiRoot": "https://littleskin.cn/api/yggdrasil", "changed": true, "insecure": false }`

| 字段 | 类型 | 说明 |
|------|------|------|
| apiRoot | string | 解析后的 API 根地址（解析失败场景下前端回退用原始输入） |
| changed | boolean | 是否与输入地址不同 |
| insecure | boolean | apiRoot 是否为明文 `http://`（前端据此显示明文传输警告） |

**错误：** 空 url → `400 BAD_REQUEST`；网络/TLS/DNS 等传输失败 → `502 UPSTREAM_ERROR`（非 2xx 响应不算失败，仍按上述规则检查 ALI 头）。
