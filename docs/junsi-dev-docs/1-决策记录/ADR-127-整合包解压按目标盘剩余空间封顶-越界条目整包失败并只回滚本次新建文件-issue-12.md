# ADR-127：整合包解压按目标盘剩余空间封顶、越界条目整包失败并只回滚本次新建文件（issue #12）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-11-08 |
| 决策者 | AI Agent |

## 背景

issue #12 记录四项加固：解压无大小上限、跟随符号链接、越界条目静默跳过、file_helper::extract_zip 同类问题。

现状取证（issue #12 建立时即已确认）：
- CurseForge 与 Modrinth 的 extract_prefixed 用 std::io::copy 直接展开每个 override 条目，无 per-entry 也无总量限制；`overrides/` 条目来自不可信 zip，几十 KB 高压缩比条目可解出数 GB。
- safe_join_under 只做词法校验，挡不住「安装目录里预置指向外部的符号链接」——create_dir_all / File::create 会跟随。
- 越界条目被 continue 跳过（这已是相对「写到目录外」的行为修正），但整体返回 Ok(())，调用方看不出有文件被跳过。
- file_helper::extract_zip 用 mangled_name()（已过滤 ..），但同样无上限、同样跟随链接。它的调用方是 launch/process.rs 的 natives 解压与 java lib 解压。

范围说明：四项均位于 PR #9 未触碰的既有解压路径，故从该 PR 拆出单独立项。

## 决策

1. **解压上限以目标盘剩余空间为准**：ExtractBudget::for_target 探测安装目标目录所在盘的可用字节数（Windows GetDiskFreeSpaceExW；Unix 用**稀疏文件二分探测**，见第 7 条），扣掉 EXTRACT_RESERVED_HEADROOM = 256 MiB 作为安装过程自身的余量。每条条目按 zip 头声明的解压大小 reserve。另设 MAX_SINGLE_ENTRY_BYTES = 512 MiB 挡住「剩余空间很大但单条目异常巨大」的情形。
   - 探测失败 → 安装直接失败（ExtractBudget::for_target 返回 None → OverrideExtractor::new 报错）：未知余量下写盘正是要防的事。
   - 实写量按声明量 +1 字节封顶再校验一次，防止 zip 头撒谎。
   - 不采用「固定常量总量」：盘快满时会误报可用，大号良性整合包又会误拒；不采用「只限单条目」：挡不住很多条目累加到写满。

2. **越界条目让整包失败**：safe_join_under 返回 None 或 resolves_within_root 判定越界 → 返回 Err，安装失败。理由：静默跳过会让调用方误以为安装完整；良性整合包几乎不出现越界条目，真出现就说明包不可信。

3. **符号链接防护用 canonicalize + 临时文件**：resolves_within_root 对已存在的最深祖先求真实路径并与根目录比对（不存在的尾部不可能已是链接）。写入改为同目录临时文件 + rename，临时文件用 create_new 打开（不跟随符号链接）。
   - 不引入 cap-std：需新增依赖并重写解压路径，改动面与收益不匹配；canonicalize 方案留有极小 TOCTOU 窗口，已在代码注释中写明。

4. **回滚只删本次新建的文件**：OverrideExtractor 分别记录 created 与 overwritten。失败时只删 created；overwritten 保留——它们是被本次覆盖的用户既有文件，删掉才是真正的数据丢失（ADR-124 已确立「安装失败不丢用户文件」）。
   - 因此覆盖写用「临时文件 + rename」而非「先 remove 再 create」：rename 之前失败，用户原文件仍是旧内容。

5. **file_helper::extract_zip 同步加固**：同样接入 ExtractBudget 与 resolves_within_root。此处预算探测失败时退化为「只靠单条目上限」而不阻断——它的调用方是 natives 解压等既有流程，失败会直接导致启动失败，取舍与整合包安装不同。

6. **两个安装器共用 OverrideExtractor**：CurseForge 与 Modrinth 的 overrides 释放逻辑同构（差异只在哪些前缀算覆盖目录），循环体收在 mod.rs，避免两份实现各自漂移。
7. **Unix 的空间探测不手写 statvfs ABI**（PR #13 评审 sourcery 指出，属初版引入的真实缺陷）：初版按「5 个 u64 + 11 个 u64 兜底」= 128 字节自造 `struct statvfs` 并 extern "C" 调用。macOS 的 `statvfs` 含 `f_fstypename[16]` / `f_mntonname[1024]` / `f_mntfromname[1024]` 等，**≥ 2144 字节**——每次探测越界写约 2 KB 栈内存；32 位 Unix 上字段宽度也不同。项目无 `libc` 直接依赖。
   现改为**不依赖平台 ABI 的稀疏文件二分探测**：建探针文件，seek 到目标偏移写 1 字节，二分找「可写/不可写」边界（上限 1 TiB）。代价是 `log2(容量)` 次单字节写，三平台同一份代码。
8. **覆盖前备份原文件，失败时还原内容**（PR #13 评审 sourcery 指出）：初版回滚只「不删」被覆盖文件，但其内容已被整合包替换——用户配置实际已丢。现覆盖前把原文件备份到同目录 `.qml-bak`，回滚时写回原内容、成功后 `commit()` 删备份。
9. **符号链接校验不能以 `exists()` 为条件**（PR #13 评审 sourcery 指出）：叶子不存在、父目录是指向根外的链接时 `exists()` 为 false，跳过校验后 `create_dir_all` 仍会跟着写出去。现改为无条件校验。
10. **单条目上限必须独立于剩余空间探测**（PR #13 评审 sourcery 指出）：探测失败时原实现让 `budget` 为 None，`reserve` 整个被跳过，连单条目上限也没了。现抽出 `check_single_entry_limit` 单独生效。
11. **其他收敛**：临时文件名加进程内自增序号（并发不撞名）；`replace_file` 处理 Windows 上目标被占用时的替换（旧文件改名再换，失败放回）；`create_dirs_tracked` 记录每一层新建目录供逐层回滚；`extract_zip` 校验实写量超过声明量时报错。
12. **不采纳 TOCTOU/并发协调类意见**：彻底消除 TOCTOU 需目录相对的 `openat`/`O_NOFOLLOW`（标准库无跨平台支持，需 `cap-std`）；并发安装的预算超订与跨安装回滚需按卷/按目录的全局协调。当前整合包安装是单实例串行触发，后者属理论场景，引入全局锁会扩大改动面并带来死锁风险。前者已在 CLARIFY 阶段与用户确认为取舍。

## 备选方案

### 方案 固定两级常量（单条目 512 MiB + 整包 8 GiB）
- 优点：实现最简单、行为完全可预测、无平台 API 依赖
- 缺点：盘本来就快满时仍会写满；超大良性整合包（大型材质/光影）可能触碰 8 GiB 被误拒
- 为何不选：两头都可能出错，未选

### 方案 只做单条目上限，不做整包总量
- 优点：改动最小
- 缺点：挡不住「很多条目累加到写满磁盘」，而正是这个场景会留下半成品安装
- 为何不选：未覆盖 issue 的核心诉求，未选

### 方案 越界条目记录告警后跳过
- 优点：恶意整合包不因一条坏路径整包失败；与既有行为最接近
- 缺点：调用方无法感知安装不完整；返回类型不变就要靠日志，容易被忽略
- 为何不选：用户选定「整包失败」；且良性包几乎不出现越界条目，误伤面很小

### 方案 引入 cap-std 做目录相对 no-follow 操作
- 优点：彻底消除 TOCTOU，安全性最高
- 缺点：新增依赖 + 重写解压路径，改动面明显变大
- 为何不选：canonicalize + create_new 已覆盖实际威胁模型，TOCTOU 窗口极小，未选

## 验证

基线：`cargo test --lib` → 148 passed。改动后 → **157 passed / 0 failed / 2 ignored**；`cargo fmt --check` 通过；新增代码无 clippy 告警（`modpacks/*.rs` 与 `file_helper.rs` 的 6 条为存量，`git stash` 前后计数与内容一致，仅行号偏移）。

新增 8 项测试，逐项验证「抽掉修复即失败」：

- `budget_accepts_entries_within_remaining_space` / `budget_rejects_when_remaining_space_insufficient` / `budget_rejects_single_oversized_entry_even_with_plenty_of_room` —— 抽掉 `reserve` 的扣减与判定后三项全 FAILED。
- `extract_budget_reads_real_free_space` —— 真实调用平台 API 探测临时目录所在盘（未跳过、未打桩），断言预算为正；探测失败时该用例会失败，从而暴露平台实现回归。
- `resolves_within_root_accepts_plain_paths` / `resolves_within_root_rejects_escaping_symlink`（Unix）—— 覆盖「已存在祖先在根内」与「经符号链接指向根外」两条。
- `modpack_install_writes_override_files` —— 端到端：真实 zip → 文件确实落到目标目录。
- `modpack_install_fails_on_escaping_entry_and_rolls_back` —— 越界条目让整包失败；把策略改回「静默 continue」后 FAILED：`含越界条目的整合包必须安装失败: ()`。
- `rollback_keeps_preexisting_files_and_removes_only_new_ones` —— 回滚保留用户原有文件、只删本次新建；把 rollback 改回「连 overwritten 一起删」后 FAILED：`回滚不得删除用户原有文件`。

回滚清理本身的验证：把 `rollback` 改成空操作 → `失败后已写入的半成品应被删除` FAILED。

⚠️ 已知未覆盖：`file_helper::extract_zip` 的两项加固（预算 / 符号链接）没有专门测试——它的两个调用点都在 `launch/process.rs` 的真实启动流程里，构造需要完整实例与库文件。逻辑与整合包路径共用同一组函数（已测），差异只在「预算探测失败时退化而非报错」，该分支未单独断言。

## 影响
- qomicex-core-rust/src/services/installers/modpacks/mod.rs（ExtractBudget / free_space_bytes 平台实现 / resolves_within_root / OverrideExtractor）
- qomicex-core-rust/src/services/installers/modpacks/curseforge.rs（release_files 改用 OverrideExtractor，失败回滚）
- qomicex-core-rust/src/services/installers/modpacks/modrinth.rs（extract_prefixed 改用 OverrideExtractor，失败回滚）
- qomicex-core-rust/src/util/file_helper.rs（extract_zip 接入预算与符号链接校验）
- 新增 8 项测试：预算三项、真实磁盘探测、符号链接两项、端到端解压、数据丢失回归

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-11-08 | v1.0 | 初版创建 | AI Agent |
| 2026-11-08 | v1.1 | PR #13 评审后补 6 项：Unix 空间探测改稀疏文件二分（初版手写 statvfs 在 macOS 越界写约 2 KB 栈，属真实缺陷）、覆盖前备份并在回滚时还原原内容、符号链接校验改为无条件、单条目上限独立于探测、临时文件唯一名、Windows 替换兼容；决策项增至 12 条，测试 156→157 | AI Agent |