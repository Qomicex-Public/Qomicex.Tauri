# Qomicex Launcher 联机（SCF）扩展协议规范 v2.0

> **面向合作启动器 / 第三方开发者的互联互通文档。**
> 本文档描述 Qomicex Launcher 联机模块基于 **SCF（Scaffolding）协议族** 的全部自定义扩展协议，以及底层的字节级传输格式，使其它启动器无需使用 Qomicex 代码即可与 Qomicex 房间互操作。

---

## 1. 背景与适用范围

Qomicex 的联机功能：
- 底层组网使用 **EasyTier**（虚拟局域网 / P2P 打洞），客户端之间通过虚拟网互相连通；
- 控制面（房间成员的加入 / 心跳 / 出栈 / 房间元数据交换）使用自定义的 **SCF 协议**，通过 TCP 在 EasyTier 网络内的联机中心（Host）与访客（Guest）之间传输；
- SCF 是**请求/响应、基于帧**的协议，帧编码为**大端（Big-Endian）**字节序，与 C# 版 `Qomicex.Connector` 的 wire 格式一致。

**文档覆盖范围**：凡是想把房间加入 Qomicex 联机网络、或在 Qomicex 房间中作为房主/访客被识别，都必须遵循：
1. [§2 传输帧格式](#2-传输帧格式-wire-format)
2. [§3 标准协议族（命名空间 `c`）](#3-标准协议族-namespace-c)
3. [§4 协商握手流程](#4-协商握手流程)
4. [§5 Qomicex 扩展协议（命名空间 `qml`）——本文核心](#5-qomicex-扩展协议-namespace-qml)

---

## 2. 传输帧格式（Wire Format）

所有字符串字段按 **ASCII** 编码；含非 ASCII 字符的字符会被替换为 `?`（与 C# `Encoding.ASCII` 一致）。所有长度字段为 **无符号 uint32 大端**。

### 2.1 请求帧（Guest → Host / Center）

```
┌──────────┬──────────────────────────┬──────────────────┬──────────────┐
│ 1  byte  │  typeLen bytes           │  4 bytes         │  bodyLen bytes │
│ typeLen  │  type 字符串 (ASCII)      │  bodyLen (BE)     │  body         │
└──────────┴──────────────────────────┴──────────────────┴──────────────┘
```

- `typeLen`：1 字节，为 `type` 字符串的字节长度（≤ 255）。
- `type`：格式为 `namespace:request_type`，例如 `qml:game_info`。
- `bodyLen`：4 字节大端，为 `body` 的字节长度。
- `body`：请求体（对 JSON 类协议为 UTF-8 JSON 字节；可为空）。

**示例**：`c:ping`、body=`0x01 0x02 0x03` 的请求帧原始字节：
```
0x06  "c:ping"  0x00 0x00 0x00 0x03  0x01 0x02 0x03
```

### 2.2 响应帧（Host / Center → Guest）

```
┌─────────┬──────────────────┬──────────────┐
│ 1 byte  │  4 bytes         │  bodyLen bytes │
│ status  │  bodyLen (BE)     │  body         │
└─────────┴──────────────────┴──────────────┘
```

- `status`：状态码。`0` 表示成功；**非 0 表示失败**（详见 §3.6）。
- `bodyLen`：4 字节大端。
- `body`：响应体。

---

## 3. 标准协议族（Namespace `c`）

无论是否接入 `qml` 扩展，都是 Qomicex 联机的**标准协议集合**。合作启动器实现这些即可被 Qomicex 房间识别的访客：

| 协议键 | 方向 | 说明 |
|:---|:---|:---|
| `c:ping` | Guest→Center | 心跳，原样回显请求体 |
| `c:protocols` | Guest→Center | 协议协商，交换双方支持列表 |
| `c:server_port` | Guest→Center | 获取房主 MC 服务器端口 |
| `c:player_ping` | Guest→Center | 玩家上线注册（资料 ping） |
| `c:player_profiles_list` | Guest→Center | 获取当前玩家列表 |
| `c:player_easytier_id` | Guest→Center |（可选）上报 EasyTier 节点 ID |

### 3.1 `c:ping`
请求体：任意（通常 `0x42`）。响应：`status=0`，body 原样回显请求体。

### 3.2 `c:protocols`（协商）
- 请求体：本端支持的协议键列表，以 **`\0`（NUL）作为分隔符**拼接的 UTF-8 字节。例如 `c:ping\0c:protocols\0...\0qml:game_info\0...`。
- 响应体：中心端支持的协议键列表，同样以 `\0` 分隔。
- 取两列表的**交集**即为双方可用协议（见 §4）。

### 3.3 `c:server_port`
- 请求体：空。
- 响应体：**2 字节大端 u16**，为房主 MC 服务器的局域网端口。
- 若 MC 服务器未启动，状态码落在 **32..=63** 区间（约定错误码），body 可为空。

### 3.4 `c:player_ping`
- 请求体：JSON 对象（snake_case）：
  ```json
  {
    "name": "玩家名",
    "machine_id": "机器标识",
    "vendor": "启动器厂商标识",
    "easytier_id": "可选，节点ID"
  }
  ```
- 响应体：空；`status=0` 表示注册成功。
- 语义：访客连接后**必须**立即发送，用于把玩家登记进房主房间列表。缺失字段回退空串；解析失败返回 `status=255`（保持连接，但 255 不刷新心跳，畸形端会在超时后被剔除）。

### 3.5 `c:player_profiles_list`
- 请求体：空。
- 响应体：JSON **数组**（snake_case），当前房间全部玩家：
  ```json
  [
    {
      "name": "玩家名",
      "machine_id": "机器标识",
      "easytier_id": null,
      "vendor": "厂商标识",
      "kind": "HOST"        // 或 "GUEST"
    }
  ]
  ```
- 房主返回的 players 会包含 Host 与 Guest；访客用它渲染房间成员列表。

### 3.6 `c:player_easytier_id`
- 兼容可选协议。若协商通过，访客在 `c:player_ping` 中携带真实 `easytier_id`；否则传空。

> **错误约定**：任何协议在 status 非 0 时的 body 均为 **UTF-8 错误消息文本**。`status=255` 为通用失败码（未知协议、序列化失败、校验失败）。

---

## 4. 协商握手流程

Qomicex 访客（Guest）加入房间时，对中心端（Host）依序执行：

1. **建立 TCP 连接**：经 EasyTier 网络直连房主虚拟 IP，或经端口转发至本地回环端口。
2. **发送 `c:player_ping`**：上报本端玩家信息（注册）。
3. **发送 `c:protocols`**：携带本端支持列表（含标准协议 + `qml:` 扩展）。取交集后，**只有双方都支持的扩展协议才能调用**。
   - 调用未协商成功的扩展协议：**不发包**，直接按“功能不可用”降级处理。
4. **启动心跳**：每 **5 秒**发送一次 `c:ping`。连续心跳失败超出窗口（约 15s）会被房主剔除。
5. 需要进入游戏时，调用 `c:server_port` 获取端口并建立 MC 数据链路。

> **兼容要点**：其它启动器实现访客侧时，若中心端（Qomicex 房主）不支持某 `qml:` 协议，应**不发送**该协议并按“该功能不可用”优雅降级，而不是断开连接。

---

## 5. Qomicex 扩展协议（Namespace `qml`）【核心】

以下是 Qomicex 注册到房间的 4 个自定义扩展协议。除特别说明外，**JSON 均为 serde 的 camelCase** 命名，响应 `status` 恒为 `0`；任何异常（反序列化/序列化失败）返回 `status=255` + UTF-8 错误文本。

| 协议键 | 方向 | 用途 |
|:---|:---|:---|
| `qml:game_info` | Guest→Host | 拉取房主投放的版本信息（MC 版本 / 加载器） |
| `qml:player_icons` | Guest↔Host | 玩家头像交换（本地上传 / 全房间拉取） |
| `qml:player_leave` | Guest→Host | 访客优雅退出通知 |
| `qml:game_mods` | Guest→Host | 拉取房主的 mods 列表（用于去重/校验） |

### 5.1 `qml:game_info`（房主版本信息）

- **请求体**：空。
- **响应体**（camelCase）：
  ```json
  {
    "gameVersion": "1.20.1",      // 必填；未知/未读到为 "unknown"
    "loader": "Forge",            // 可选；原版/未知为 null
    "loaderVersion": "47.1.0"     // 可选；原版/未知为 null
  }
  ```
  | 字段 | 类型 | 说明 |
  |:---|:---|:---|
  | `gameVersion` | string | Minecraft 版本号，必填 |
  | `loader` | string \| null | 加载器类型，如 `Forge` / `Fabric` / `NeoForge`，**原版或未知为 `null`** |
  | `loaderVersion` | string \| null | 加载器版本，原版或未知为 `null` |

- **宿主（Host）语义**：由 `host/instance` 建房时读实例注入；`host/port` 手动建房时从游戏版本 JSON 解析（读不到回退进程参数 `--version` 原值，可能为 `"unknown"`）。
- 访客把 `gameVersion` + `loader` 用做“快速匹配/过滤本地实例”的基准（`/connector/match-instances`）。

### 5.2 `qml:player_icons`（头像交换）

双向：访客上传自己的头像，中心端返回**全房间**的头像映射。

- **请求体**（camelCase）：
  ```json
  {
    "machineId": "本机机器标识",
    "iconBase64": "base64 编码的头像 PNG/皮肤数据（可为空串）"
  }
  ```
  | 字段 | 类型 | 说明 |
  |:---|:---|:---|
  | `machineId` | string | 上传方机器标识，**必填且非空** |
  | `iconBase64` | string | base64 头像字节；为空串时**只拉取**（刷新），不覆盖本端头像 |

- **响应体**（camelCase）：
  ```json
  {
    "icons": {
      "machineId_A": "base64...",
      "machineId_B": "base64..."
    }
  }
  ```
  | 字段 | 类型 | 说明 |
  |:---|:---|:---|
  | `icons` | object（string→string） | 全房间 `machineId → base64 头像` 映射 |

- 行为：中心端把上传方的 `machineId → iconBase64` **合并**进房间映射，再返回当前完整映射。`machineId` 或 `iconBase64` 为空时**不写入**（只返回现有映射）。
- **触发时机**：访客加入后立即上传一次自己的头像（拉回全房间映射）；之后每次房间玩家数变化，会再次以 `iconBase64=""` 调用以拉取最新头像集合。

### 5.3 `qml:player_leave`（退出通知）

访客优雅退出时通知房主把自己从房间移除。

- **请求体**（camelCase）：
  ```json
  {
    "machineId": "要移除的机器标识"
  }
  ```
- **响应体**：单个 JSON **布尔**值 `true`。
- 行为：房主根据 `machineId` 移除房间内该玩家的记录与其头像。
- **注意**：它不是踢人控制；踢人仅房主侧 `/connector/kick` 可用（三层强制断开），非 QML/SCF 客户端不受该协议约束。

### 5.4 `qml:game_mods`（房主 mods 列表）

- **请求体**：空。
- **响应体**（camelCase）：
  ```json
  {
    "mods": [
      {
        "source": "modrinth",          // "modrinth" | "curseforge" | ""（未查到来源）
        "id": "AANobbMI",              // Modrinth 项目 id / CurseForge mod id；未查到来源为空串
        "hash": "a1b2c3...",           // 文件 SHA1（小写十六进制）
        "name": "My Mod"               // mod 显示名
      }
    ]
  }
  ```
  | 字段 | 类型 | 说明 |
  |:---|:---|:---|
  | `mods` | array | 房主 mods；**空数组 = 无 mods** 或**尚未扫描完成** |
  | `mods[].source` | string | `modrinth` / `curseforge` / `""` |
  | `mods[].id` | string | 对应来源的项目/mod id；`source=""` 时为空串 |
  | `mods[].hash` | string | 文件 SHA1（小写十六进制） |
  | `mods[].name` | string | mod 显示名 |

- 访客用它和本地实例 mods 的 SHA1 集合比对，判定“房主 mods 是否齐全”。
- **兼容提示**：房主在 `host/port` 手动建房且未解析到游戏目录、或扫描仍在后台进行时，可能**先返回空列表**；访客不应把“空”立即判定为无 mods，可按需重复拉取。

---

## 6. 兼容实现建议（给合作启动器）

### 6.1 作为"访客"（Guest）加入 Qomicex 房间
1. 实现 §3 的标准协议 + §4 协商流程，并把 `qml:*` 四键加入你的 `c:protocols` 支持列表（若你想用 Qomicex 的扩展功能）。
2. 连接后：`c:player_ping` 注册 → `c:protocols` 协商 → 循环 `c:ping` 心跳（5s）。
3. 需要看房主版本信息 → 调 `qml:game_info`；需要头像 → 调 `qml:player_icons`；退出 → 调 `qml:player_leave`；校验 mods → 调 `qml:game_mods`。
4. **不支持的扩展协议不发包**，按功能缺失降级（Qomicex 房主在这点上已做兼容）。

### 6.2 作为"房主"（Host）向 Qomicex 访客提供服务
若你要成为房主、让 Qomicex 访客加入：
1. 注册标准协议 + 以上 4 个 `qml:` 协议（键名、响应结构见 §5）。
2. 在 `c:protocols` 响应中返回你的全部支持列表，确保 Qomicex 访客能协商到需要的 `qml:` 键。
3. `qml:player_icons` 维护一个房间级 `machineId → iconBase64` 映射并在响应中返回全量。
4. `qml:player_leave` 按 `machineId` 从房间移除玩家。

### 6.3 多实现一致性速查
- 字节序：全部字段**大端**。
- 字符串：ASCII（非 ASCII 替换为 `?`）。
- 命名：JSON 负载 **camelCase**（`gameVersion`、`machineId`、`iconBase64`…）；`c:` 标准协议用 **snake_case**（`machine_id`、`easytier_id`…）。
- 状态码：`0`=成功，`255`=通用失败（body=UTF-8 错误文本），`32..63`=`c:server_port` 的“MC 未启动”。
- 协商未通过不调用、不发包、不断连。

---

## 7. 相关代码位置

| 项目 | 路径 |
|:---|:---|
| 协议帧编解码 | `qomicex-connector-rust/crates/qomicex-connector/src/core/protocol_serializer.rs` |
| 协商 | `.../core/protocol_negotiator.rs` |
| 标准协议处理器 | `.../protocols/mod.rs` |
| `DelegateProtocol`（扩展协议注册器） | `.../protocols/mod.rs`（`new_json` / `new_json_req`） |
| 访客侧调用（`send_json` / `send_json_req`） | `.../guest/scaffolding_guest.rs` |
| Qomicex 后端注册 4 个 `qml` 协议 | `src-backend/qomicex-backend/src/endpoints/connector.rs`（`custom_protocols`） |
| 房主踢人 / 三层断开 | `src-backend/qomicex-backend/src/endpoints/connector.rs::kick_player` |
