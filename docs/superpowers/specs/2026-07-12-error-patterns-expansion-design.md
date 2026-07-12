# 错误模式扩充设计

## 目标

参照 PCL (Plain Craft Launcher) 的 48 种崩溃原因，为 Qomicex 补充缺失的错误检测模式，并配上详细中文解决方案。

## 范围

在现有 `error-patterns.json` + `MinecraftLogAnalyzer` 基础上，新增约 17 种模式，分 5 类：

### 1. 显卡驱动细分（5 种）

| 模式 ID | 检测条件 | 说明 |
|---------|---------|------|
| `gpu-intel-access-violation` | `EXCEPTION_ACCESS_VIOLATION` + `# C  [ig` | Intel 核显驱动不兼容 |
| `gpu-amd-access-violation` | `EXCEPTION_ACCESS_VIOLATION` + `# C  [atio` | AMD 显卡驱动不兼容 |
| `gpu-nvidia-access-violation` | `EXCEPTION_ACCESS_VIOLATION` + `# C  [nvoglv` | Nvidia 显卡驱动不兼容 |
| `gpu-pixel-format` | `Couldn't set pixel format` / `Pixel format not accelerated` | 无法设置像素格式 |
| `gpu-opengl-not-supported` | `The driver does not appear to support OpenGL` | 显卡不支持 OpenGL |

### 2. OptiFine 相关（3 种）

| 模式 ID | 检测条件 | 说明 |
|---------|---------|------|
| `optifine-forge-incompatible` | OptiFine 特定的 6 种 `NoSuchMethodError` / `The Mod File optifine` | OptiFine 与 Forge 不兼容 |
| `optifine-world-load` | `ChunkManager$ProxyTicketManager.shouldForceTicks` + `OptiFine` | OptiFine 导致无法加载世界 |
| `shadersmod-optifine-conflict` | `Shaders Mod detected. Please remove it` | ShadersMod 与 OptiFine 冲突 |

### 3. Forge 细分（3 种）

| 模式 ID | 检测条件 | 说明 |
|---------|---------|------|
| `forge-incomplete-install` | `Cannot find launch target fmlclient` / `Invalid paths argument` + `fmlcore` | Forge 安装不完整 |
| `forge-multiple-json` | `Found multiple arguments for option fml.forgeVersion` | 版本 Json 中存在多个 Forge |
| `forge-old-version-java` | `NoSuchMethodError: sun.security.util.ManifestEntryVerifier` | 低版本 Forge + 高版本 Java |

### 4. Java 细分（3 种）

| 模式 ID | 检测条件 | 说明 |
|---------|---------|------|
| `java-openj9` | `Open J9 is not supported` / `OpenJ9 is incompatible` / `.J9VMInternals.` | 使用 OpenJ9 JVM |
| `java-32bit` | `Invalid maximum heap size` / `Could not reserve enough space for 1048576KB` | 32 位 Java 内存限制 |
| `java-mod-needs-11` | `class file version 55.0` + `only recognizes` + `JAVA_11 could not be set` | Mod 需要 Java 11 |

### 5. 其他（3 种）

| 模式 ID | 检测条件 | 说明 |
|---------|---------|------|
| `mod-extracted` | `Extracted mod jars found` / `The directories below appear to be extracted jar files` | Mod 文件被解压 |
| `mod-id-limit` | `maximum id range exceeded` | Mod 过多超出 ID 限制 |
| `mixin-bootstrap-missing` | `ClassNotFoundException: org.spongepowered.asm.launch.MixinTweaker` | MixinBootstrap 缺失 |

## 解决方案文本要求

每种模式的解决方案必须包含：
1. **问题原因** — 一句话说明为什么会崩溃
2. **具体操作步骤** — 用户应该做什么，路径明确（如"在 版本设置 → Java 选项中"）
3. **兜底建议** — 如果上述步骤无效该怎么办

中文编写，参考 PCL 的详尽风格。

## 实现方式

纯配置 + 后端改动，前端无需变更：

| 改动 | 文件 |
|------|------|
| 新增 17 种模式 | `src-backend/Qomicex.Core/Resources/LogAnalysis/error-patterns.json` |
| 补充 Mod 名称交叉匹配（如需） | `src-backend/Qomicex.Core/Modules/Helpers/LogAnalysis/MinecraftLogAnalyzer.cs` |

## 不在此轮范围

- Mod 名称交叉匹配（堆栈 ↔ Mod 列表）— 留到第二轮
- 智能日志收集 — 留到第三轮
- UI 变更
- 前端改动
