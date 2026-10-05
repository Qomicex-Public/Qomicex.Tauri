# ADR-106：JarMod 支持：非破坏性派生 jar 注入古董包 modpack.jar（issue #180）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-05 |
| 决策者 | AI Agent |

## 背景

issue #123 期2 的 #180：Technic 古董整合包（`bin/modpack.jar` 内**无** `version.json`，约 1.4.x 及更早）需要把该 jar 作为 **JarMod** 注入游戏才能启动。期1 对这类包明确返回 `TECHNIC_JARMOD_UNSUPPORTED` 并预留占位（`qomicex-core-rust/src/services/jarmod.rs`）。

调研阶段确认了三条会否决初版思路的硬事实：

1. **直接改写主 jar 必然失败**：`qomicex-core-rust/src/services/version/locator.rs::get_miss_main_jar` 按 `downloads.client.sha1` 强校验主 jar，不匹配即重新下载覆盖；该检查在**启动前**（`endpoints/instance.rs`）与**装完后**（`services/install_service.rs`）各跑一次。改动会被静默抹掉；若为绕过它而关掉完整性校验，代价是放弃整个实例的库/资源校验，不可接受。
2. **Prism 的真实做法不是「classpath 前置」**：`ModMinecraftJar.cpp` 生成一个**临时合并 jar**，`LaunchProfile.cpp` 让该临时 jar 顶替主 jar 在 classpath 中的位置。HMCL 则是**破坏性**覆盖主 jar。两者都没有独立的 classpath 前置实现 → issue 里「c) 对齐 HMCL/MultiMC」在落地层等同于「a) 合并」，而「b) classpath 前置」在上游无先例。
3. **MMC 的 `jarMods` 在 QML 里原本是死键**：`services/multimc.rs` 的 `apply_patch` 用 `_ =>` 兜底把未知键原样写进版本 JSON，但没有任何消费方。

夹具（用户提供，已实测核对）：F1a = 真实 Agrarian Skies 的 `modpack.jar`（真 Forge 965 universal + FML）剥掉 jar 内 `version.json` 重打包（59.9MB，含 `fmlversion.properties` 与 `forgeversion.properties`）；F1b = 合成的最小包（只有 `fmlversion.properties`，190 字节 jar）。

> **明确未支持（如实记录，不装作支持）**：MMC 原生 `jarMods` 的元素是**库对象**（带 `name`/`MMC-hint`/`MMC-filename`，需按 maven 规则推导落盘路径），本实现只消费**字符串路径数组**。因此 MultiMC 实例携带的 `jarMods` 目前**不会被注入**——`jarmods_from_json` 检测到对象元素会打印明确告警（静默忽略会让人误以为已生效）。该缺口不影响本 issue 的 Technic 目标（technic 导入写入的是字符串形态），如后续要支持 MultiMC jarmod，需在此处补 maven 路径解析。

## 决策

**采用「数据层 + 非破坏性派生 jar」：主 jar 保持字节不变，jarmod 合并到独立的派生文件。**

**1) 数据层**：版本 JSON 增 `jarmods` 数组（同时接受 MMC 的 `jarMods` 拼写，因为 MultiMC 导入路径会把该键原样透传，MMC 生态用它）。路径**相对版本目录**。**缺失 / null / 空数组一律视为「无 jarmod」**——这是「对期1 标准包零影响」的保证点：标准包不产生该字段，启动行为逐字不变。

**2) 落盘**：`install_technic_jarmod` 把 `bin/modpack.jar` 复制到 `versions/{VDN}/jarmods/modpack.jar`，并把 `"jarmods": ["jarmods/modpack.jar"]` 追加进版本 JSON。必须在 `run_install_pipeline` **之后**执行（版本 JSON 由该管线生成）。落盘失败即导入失败（不静默降级）：该 jar 是这类包唯一的 mod 载体，落盘不成实例即使「装上了」也跑不出整合包内容。

**3) 合并与选用**：`services/jarmod.rs` 把「主 jar + jarmods」合并为 `versions/{VDN}/{VDN}-jarmod.jar`，`jvm_args.rs` 在版本 JSON 声明了 `jarmods` 且派生文件可用时**优先选用它**顶替主 jar 进入 classpath。合并顺序对齐 Prism `MMCZip`：**jarmod 条目在先 → 同名条目以先出现者为准（jarmod 覆盖原版）→ 原版条目在后且过滤 `META-INF/`**（签名文件与老 Forge 的 MANIFEST 冲突）。合并走「临时文件 + rename」，失败不留半个派生 jar（否则下次启动会当成可用）。

**4) 失败不阻断启动**：合并/读取失败时回退到原主 jar 并打印原因（宁可少一层 jarmod，也不要因缓存写不进去而完全起不来）。`jarmods` 值畸形同样只按「无 jarmod」处理，不让一个原本能启动的实例被扩展字段拖死。

**5) 增量复用**：派生 jar 存在且不比任一输入（主 jar 或 jarmod）旧时直接复用；用户替换 jarmod 后无需手动清缓存。

**6) 古董包元数据解析**（对齐 Prism `TechnicPackProcessor`）：MC 版本取 `fmlversion.properties` 的 `fmlbuild.mcversion`；Forge 版本由 `forgeversion.properties` 的 `forge.major/minor/revision/build.number` 拼成。**任一字段缺失时不识别 loader**（而不是拼出半截版本号让安装管线去 404）；两者都拿不到 MC 版本时报专门的 `TECHNIC_ANCIENT_PACK_NO_VERSION`。

核心改动在 `qomicex-core-rust`，按仓库既有惯例（同 core #4 先例）**单独 PR**。

## 备选方案

### 方案 启动前把 jarmod 内容合并进主 jar（原地改写）
- 优点：实现最直接；classpath 无需改动
- 缺点：主 jar 是 downloads.client.sha1 的校验对象，启动前与装完后各校验一次 → 改动被静默覆盖；若关掉校验则放弃全实例完整性检查
- 为何不选：已实测否定，且代价是放弃完整性校验

### 方案 classpath 前置注入（不生成派生文件）
- 优点：最轻量，无额外落盘
- 缺点：实测 Prism/HMCL 都无此实现；对资源加载顺序敏感的老 mod 行为存疑（老 Forge 依赖主 jar 内的类次序）
- 为何不选：上游无先例，行为风险无从对照

### 方案 对齐 HMCL：破坏性覆盖主 jar
- 优点：实现简单
- 缺点：同样撞 SHA1 校验；且不可逆（用户原始 jar 被覆盖后无备份）
- 为何不选：与派生 jar 相比没有任何优势且更危险

### 方案 为绕过校验而启用 skip_integrity_check
- 优点：能让原地合并「生效」
- 缺点：放弃整个实例的库/资源完整性校验（缺失/损坏文件不再被发现）
- 为何不选：代价远超收益，拒绝

## 影响
- qomicex-core-rust/src/services/jarmod.rs（占位常量替换为真实实现：解析/合并/派生/新鲜度，10 个单测）
- qomicex-core-rust/src/services/launch/jvm_args.rs（ParsedConfig 增 jarmods + 派生 jar 优先选用）
- src-backend/qomicex-backend/src/services/technic.rs（解除古董包拒绝 + fmlversion/forgeversion 解析 + TechnicMeta.jarmod，新增 5 个单测）
- src-backend/qomicex-backend/src/endpoints/modpack.rs（install_technic_jarmod 落盘 + 版本 JSON 声明 jarmods）
- docs/junsi-dev-docs/3-API规范/API列表.md（TECHNIC_JARMOD_UNSUPPORTED 条目更新为已支持）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-05 | v1.0 | 初版创建 | AI Agent |