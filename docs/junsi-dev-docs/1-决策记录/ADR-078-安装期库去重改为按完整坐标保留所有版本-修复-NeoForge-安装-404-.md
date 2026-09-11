# ADR-078：安装期库去重改为按完整坐标保留所有版本（修复 NeoForge 安装 404）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-09-11 |
| 决策者 | AI Agent |

## 背景

NeoForge 安装失败：处理器下载 asm-commons-9.3.jar 时 404，URL 为 `https://maven.neoforged.net/releases|https://libraries.minecraft.net/org/ow2/asm/asm-commons/9.3/...`（两个 base 被 `|` 拼成一体）。根因：install_profile.json 的 libraries 同时声明 asm-commons 9.10.1 与 9.3，而 processor classpath 需要 9.3；安装期 check_libs_ver_static 按 Name 去重取最高 Version → 只留 9.10.1，9.3 被丢弃；run_processor 发现缺失后自行下载，其 URL 拼接未处理 base_url 的 `|` 多源（get_miss_*_libraries 有处理，run_processor 漏了）。用真实安装器 NeoForge-21.1.250 验证：旧行为 63 库（asm-commons 仅 9.10.1），新行为 70 库（9.3 与 9.10.1 均保留）。

## 决策

把安装期两处 check_libs_ver_static（forge/install.rs、neoforge/install.rs）从「按 Name 去重取最高 Version」改为「按 FullName（完整坐标）去重，保留所有不同版本」。这样 processor classpath 显式需要的旧版本（如 asm-commons:9.3）会被 get_miss_*_libraries 预下载，run_processor 不再触发自行下载与畸形 URL。补回归测试断言不同版本全部保留、完全相同的坐标只留一条。

## 备选方案

### 方案 改 run_processor 为多源探测（与 get_miss 对齐）
- 优点：同时修复畸形 URL
- 缺点：未从根因解决（9.3 仍缺失，只是下载路径能容错）；用户明确要求从库来源解决
- 为何不选：舍弃（作为备选保留）

### 方案 仅改 NeoForge 的去重
- 优点：改动面小
- 缺点：Forge / Cleanroom 安装器同样有此缺陷，仅改 NeoForge 不彻底
- 为何不选：舍弃

### 方案 两处 check_libs_ver_static 均改为按 full_name 去重
- 优点：根治：processor classpath 依赖均已预下载，不再触发 run_processor 的 URL 拼接
- 缺点：安装期会多下载若干旧版库（体积/耗时略增）；若 processor 真的需要旧版则这是必要的
- 为何不选：采纳

## 影响
- qomicex-core-rust/src/services/installers/forge/install.rs
- qomicex-core-rust/src/services/installers/neoforge/install.rs

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-09-11 | v1.0 | 初版创建 | AI Agent |