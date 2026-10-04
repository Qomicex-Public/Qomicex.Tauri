# ADR-102：Technic SingleZip 整合包本地导入（issue #123 期1）——探测/转换对齐 Prism，古董包 JarMod 拒绝并转 #180

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-05 |
| 决策者 | AI Agent |

## 背景

issue #123（[Feature] 添加 Solder 整合包、Single Zip 整合包导入支持）：QML 无法导入老 Technic 启动器时代的 `minecraft/bin/modpack.jar` 包。经与维护者确认分期：期1 = SingleZip 本地导入（本次）；期2 = JarMod 支持（#180）+ 资源中心 Technic 源（#151）；期3 = Solder（#181）。上游（main 分支、远程分支、issue/PR）确认均未实现该能力，故自研。

现状：`endpoints/modpack.rs` 的 `parse_local_pack_file` 仅识别 Modrinth（modrinth.index.json）/ CurseForge（manifest.json）/ Qomicex（qmodpack.index.json），`is_multimc_zip` 识别 MultiMC（mmc-pack.json）走独立导入管线 `multimc_import_impl`；拖拽分类 `classify_zip`（resource_download.rs）同样不含 Technic 特征。Prism `TechnicPackProcessor.cpp` 是该格式的权威参照实现（issue 评论区已给出调研）。

## 决策

期1 范围（全部已实现并实测）：

1. **探测**（`services/technic.rs`）：`is_technic_zip` 只读中央目录匹配 `bin/modpack.jar` | `bin/version.json`（issue #119 性能手法，杜绝 by_index 逐条目 seek）。
2. **元数据解析**（`services/technic.rs::parse_technic_zip`）：对齐 Prism——MC 版本 = `bin/version.json`（或 modpack.jar **内** version.json）的 `inheritsFrom`；loader 由 libraries[] 坐标识别（forge 的 fmlloader/forge/minecraftforge 坐标、fabric、quilt、neoforge 经 game 参数反查）；forge 版本提取规则：首段 `1.x` 前缀 + 末段 MC 回显时取倒数第二段（`1.7.10-10.13.4.1614-1.7.10` → `10.13.4.1614`，Prism section('-',1,1) 等价语义）。
3. **古董包（jar 内无 version.json）明确拒绝**：错误码 `TECHNIC_JARMOD_UNSUPPORTED`，注释指向 #180；`qomicex-core-rust/src/services/jarmod.rs` 预留 TODO 占位模块（submodule 单独提交）。
4. **导入管线**（`endpoints/modpack.rs::technic_import_impl`）：骨架对齐 MultiMC 导入——RAII 临时清理（解压目录 + 上传 zip）、大包后台解压、全局锁选名、失败回滚实例、版本隔离**强制**（zip 根 = minecraft 目录）。步骤表 extract(15) → install-game(55，嵌套 `run_install_pipeline` 装 MC+loader) → copy-files(25) → finalize(5)。`copy_technic_content` 拷贝时剔除 `bin/`（安装残壳不参与启动）、`libraries/` 落共享库目录。
5. **入口分流**：`/modpack/parse`、`/modpack/parse-path`、`install-direct` 增加 technic 分支（MultiMC 探测之后、CF/MR/QML 之前）；新增 `POST /modpack/technic/import`；`classify_zip` 增加 `bin/*` 特征 + `technic_pack_meta` 预览元数据；`system.rs` 的 modpack-temp 清理/统计纳入 `technic-imports`。
6. **前端零新交互**：ImportDialog 现有 zip 过滤已接住，仅 `handleInstall` 增加 `packType === 'technic'` 分流调 `startTechnicImport`（60s 超时同 MultiMC）。

**舍弃方案**：B（一次性实现 SingleZip + Solder + 资源中心源：PR 体积与回归面过大，Solder 依赖 technicpack.net 可达性未知）；C（QML 内实现 Prism 式组件系统：工程量数量级不对）。`version.json` 里的 libraries 仅用于识别 loader，不直接安装第三方库副本（游戏文件一律由标准管线按官方 manifest 下载，对齐 Prism）。

## 备选方案

（未记录备选方案）

## 影响
- src-backend/qomicex-backend/src/services/technic.rs（新增：探测+解析+loader 识别）
- src-backend/qomicex-backend/src/endpoints/modpack.rs（technic 分流 + POST /modpack/technic/import + 导入管线 + copy_technic_content）
- src-backend/qomicex-backend/src/endpoints/resource_download.rs（classify_zip 识别 technic + 预览元数据）
- src-backend/qomicex-backend/src/endpoints/system.rs（modpack-temp 清理/统计纳入 technic-imports）
- qomicex-core-rust/src/services/jarmod.rs（新增 TODO 占位，#180 对接点，submodule 单独提交）
- src/api/instance.ts + src/components/ImportDialog.tsx + src/types/index.ts（packType=technic 分流）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-05 | v1.0 | 初版创建 | AI Agent |