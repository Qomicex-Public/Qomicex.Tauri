# Neo Backend: ASP.NET Core Minimal API + NativeAOT

## 背景

现有后端 `Qomicex.Launcher.Backend` 使用 ASP.NET Core MVC，不支持 NativeAOT。新的启动核心 `Qomicex.Core.AOT` 已重写为零依赖、AOT 兼容的库。本设计创建一个全新的后端 `Qomicex.Launcher.Backend.Neo`，使用 ASP.NET Core Minimal API + NativeAOT，并接入 `Qomicex.Core.AOT` 中已完成的功能。

## 范围

**仅实现 Core.AOT 已覆盖的功能：**
- 认证（离线 / Microsoft OAuth / Yggdrasil）
- 版本管理（远程列表 / 本地安装 / 卸载）
- 资源补全（库 / 资源文件下载）
- 启动执行（JVM 参数构建 / 进程管理）
- 实例管理（Backend 层自己管理，JSON 文件持久化）
- 系统端点（健康检查 / 系统信息）

**不包括（等 Core.AOT 后续版本）：** Mod 管理、整合包、Java 发现、皮肤、LAN 游戏、派对系统、日志分析等。

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | ASP.NET Core Minimal API (`net10.0`) |
| AOT | `PublishAot=true`, `IsAotCompatible=true` |
| 序列化 | System.Text.Json 源生成 |
| 核心库 | `Qomicex.Core.AOT`（项目引用） |
| 下载库 | `Qomicex.Downloader`（项目引用，为未来预留） |
| 存储 | JSON 文件（与旧后端格式兼容） |

## 项目结构

```
Qomicex.Launcher.Backend.Neo/
├── Qomicex.Launcher.Backend.Neo.csproj
├── Qomicex.Launcher.Backend.Neo.slnx
├── Program.cs
├── appsettings.json
│
├── Endpoints/
│   ├── AuthEndpoints.cs           # /api/auth/*
│   ├── VersionEndpoints.cs        # /api/versions/*
│   ├── LaunchEndpoints.cs         # /api/launch/*
│   ├── ResourceEndpoints.cs       # /api/resources/*
│   ├── InstanceEndpoints.cs       # /api/instances/*
│   └── SystemEndpoints.cs         # /api/health, /api/system
│
├── Middleware/
│   └── ErrorHandlingMiddleware.cs
│
├── Models/
│   ├── GameInstance.cs
│   └── ApiError.cs
│
├── Services/
│   └── InstanceService.cs
│
└── JsonContext/
    └── ApiJsonContext.cs
```

## API 端点

### Auth (Core.AOT)

| 方法 | 路由 | 说明 |
|---|---|---|
| POST | `/api/auth/offline` | 离线登录 |
| POST | `/api/auth/microsoft/device-code` | 开始 Microsoft 设备码认证 |
| POST | `/api/auth/microsoft/poll` | 轮询 Microsoft 认证结果 |
| POST | `/api/auth/microsoft/refresh` | 刷新 Microsoft token |
| POST | `/api/auth/yggdrasil` | Yggdrasil 认证 |
| POST | `/api/auth/validate` | 验证 token |
| POST | `/api/auth/invalidate` | 作废 token |

### Versions (Core.AOT)

| 方法 | 路由 | 说明 |
|---|---|---|
| GET | `/api/versions` | 获取远程版本列表 |
| GET | `/api/versions/{name}` | 获取指定版本的元数据 |
| GET | `/api/versions/installed` | 获取已安装版本列表 |
| POST | `/api/versions/{name}/install` | 安装版本 |
| POST | `/api/versions/{name}/uninstall` | 卸载版本 |

### Launch (Core.AOT)

| 方法 | 路由 | 说明 |
|---|---|---|
| POST | `/api/launch` | 启动游戏 |
| POST | `/api/launch/{pid}/kill` | 终止进程 |

### Resources (Core.AOT)

| 方法 | 路由 | 说明 |
|---|---|---|
| POST | `/api/resources/complete` | 启动资源补全下载 |
| GET | `/api/resources/complete/progress` | 获取下载进度 |

### Instances (Backend)

| 方法 | 路由 | 说明 |
|---|---|---|
| GET | `/api/instances` | 列出现有实例 |
| POST | `/api/instances` | 创建实例 |
| GET | `/api/instances/{id}` | 获取实例详情 |
| PUT | `/api/instances/{id}` | 更新实例 |
| DELETE | `/api/instances/{id}` | 删除实例 |

### System (Built-in)

| 方法 | 路由 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/system/info` | 系统信息 |

## 服务注册与生命周期

```
Program.cs 流程:
1. 加载 appsettings.json（嵌入式）
2. 配置 Kestrel (500 MB limit)
3. 构建 Core.AOT 的 DefaultGameCore
4. 注册 Backend 服务 (InstanceService)
5. 注册 CORS, JSON source gen
6. 注册中间件: ErrorHandling → CORS → Endpoints
7. Map 各领域端点
8. Run
```

## 错误处理

复用旧后端的 `ApiException` 模式，统一响应格式：

```json
{ "code": "ERROR_CODE", "message": "...", "status": 500 }
```

异常映射规则：
- `ApiException` → 自定义 code 和 status
- `VersionNotFoundException` → 404
- `DownloadFailedException` → 502
- 其他 → 500

## 存储

实例 JSON 文件存储在 `{BaseDir}/QML/instances/{id}.json`，与旧后端 `Qomicex.Launcher.Backend` 完全兼容。`GameInstance` 模型字段保持一致。

## 与旧后端的差异（递延到后续）

以下功能在 Core.AOT 完成后逐步添加：
- Mod/资源包/光影/存档/数据包 CRUD
- 整合包安装 (FTB/Modrinth/CurseForge)
- Java 运行时发现与下载
- 皮肤服务
- MC百科中文名称
- LAN 游戏发现
- 派对系统 (Qomicex.Connector)
- 日志分析
- 崩溃上传
- 设置管理
- 进度 SSE
