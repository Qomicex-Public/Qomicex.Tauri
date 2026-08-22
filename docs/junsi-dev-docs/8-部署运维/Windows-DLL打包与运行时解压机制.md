# Windows DLL 打包与运行时解压机制

> 生成时间：2026-08-23 03:29

# Windows DLL 打包与运行时解压机制

> 适用范围：Windows x64 / arm64 NSIS 与 MSI 安装包
> 关联：`release.yml`、`src-tauri/src/lib.rs`

## 背景问题（常见误判）

安装完成后，安装目录（如 `%LOCALAPPDATA%\Qomicex Launcher`）里只有主程序与卸载器，**看不到 `Packet.dll` / `wintun.dll`** —— 这不是打包遗漏，而是刻意设计：DLL 以字节流嵌入主 exe，首次启动时解压到后端运行目录。

## 完整链路

```
CI 构建期（release.yml）
  ├─ cargo build --target <triple> 后端
  ├─ Copy-Item easytier/third_party/<arch>/Packet.dll → src-tauri/binaries/   (x64: L294-300, arm64: L387-392)
  └─ Copy-Item easytier/third_party/<arch>/wintun.dll → src-tauri/binaries/

编译期（src-tauri/src/lib.rs:21-32）
  └─ include_bytes! 将 backend.exe + Packet.dll + wintun.dll 嵌入主 exe
     （debug 构建为空占位 &[]，因此 dev 模式需手动准备后端）

用户机运行期（lib.rs:67-93 extract_backend + lib.rs:96-107 extract_sidecar_dlls）
  └─ 首次启动解压三件套到 %TEMP%\qomicex\：
     qomicex-backend.exe / Packet.dll / wintun.dll（同目录满足 DLL 加载要求）
```

## 为什么这样设计

1. **免写权限问题**：Program Files 类安装路径不需要管理员即可写 %TEMP%
2. **版本强绑定**：DLL 与后端二进制同生共死；arm64 包嵌 arm64 版 Packet.dll（x64 版混入会直接 0xC0000135）
3. **卸载干净**：安装目录不留孤儿 DLL；%TEMP%\qomicex\ 由后端生命周期管理

## 运行时验证方法

| 检查项 | 方法 | 通过标准 |
|---|---|---|
| 解压是否发生 | 查看 `%TEMP%\qomicex\` | 三件套齐全且时间戳为最近一次启动 |
| Packet.dll 加载 | 任务管理器看 `qomicex-backend` 进程 | 进程存活即加载 OK（缺失会立刻 0xC0000135 退出） |
| 安装包体积 | 主 exe ≈ 80MB | 异常偏小说明嵌入失败（binaries/ 缺文件时 CI 会编译失败） |

## 排查指引

- **后端秒退 + 事件查看器 0xC0000135**：%TEMP%\qomicex\ 缺 Packet.dll → 检查对应架构的 release.yml 复制步骤是否执行、主 exe 是否为新构建
- **联机 faketcp 不可用但进程存活**：Packet.dll 只是 npcap API 层，系统还需安装 **npcap 驱动**本身
- **TUN 模式不可用（非管理员）**：预期行为，自动回退 no-tun（smoltcp 用户态栈）；管理员模式需 wintun.dll（动态加载，缺失不崩进程）


## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
| 2026-08-23 | v1.0 | 初版创建 | AI Agent |