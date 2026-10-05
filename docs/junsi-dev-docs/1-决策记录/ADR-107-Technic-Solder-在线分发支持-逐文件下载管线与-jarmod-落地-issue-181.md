# ADR-107：Technic Solder 在线分发支持：逐文件下载管线 + jarmod 落地（issue #181，#123 期3）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-05 |
| 决策者 | AI Agent |

## 背景

issue #123 期3 = issue #181。资源中心 Technic 源（期2 #151）里 13/45 候选是 Solder 分发形态（详情接口 url=null 且 solder 有值；tekkit-classic/hexxit/tekkit-legends 等知名 1.4.7 时代包全部如此），安装时只报 TECHNIC_SOLDER_UNSUPPORTED。期1 实测已固化 Solder 协议事实：{solder}/modpack/{slug} 返回 builds/recommended/latest，{solder}/modpack/{slug}/{build} 返回 minecraft/forge/mods[]（每项 name/version/md5/url/filesize），基地址 https://solder.technicpack.net/api/，无需 UA、无需 build 参数。夹具 C:\Project\Qomicex.TestPacks\solder-tekkit-312\ 已备 Tekkit 3.1.2 全部 30 个 mod zip（MD5 全部验证）+ pack/build 两个 JSON。实现前逐 zip 开箱实测发现三个决定架构的事实：① Solder mod zip 是「mini minecraft 目录覆盖包」（mods/*.zip、bin/modpack.jar、config/…），按 mods[] 顺序解压叠加成完整 minecraft 目录；② basemods-*.zip 内含 bin/modpack.jar（492 项，mod_MinecraftForge.class + FML 类）——1.2.5 时代 Forge 就靠它分发，期2-B (#180) 的 jarmod 机制正是为此准备；③ forge=164 是裸 build 号，1.2.5 无 installer.jar，core 的 install_legacy_forge 走不通，Forge 安装器路径不可用。

## 决策

采用方案 A「Solder 原生管线」。core：models/expansion/technic.rs 新增 TechnicSolderPack（selected_build: recommended→latest→builds 末位）/ TechnicSolderBuild / TechnicSolderMod（md5/url 用 Option + de_opt_string_or_number，吸收「#[serde(default) 不覆盖显式 null」的坑）；trait TechnicSource 增 get_solder_pack / get_solder_build（404→Ok(None) 与 get_pack_detail 同语义）；query.rs 实现裸 GET（无 build 参数）。backend：modpack.rs 新增 solder_import_impl（install_direct 的 technic 分支判 distribution()==Solder 时进入；同步解析元数据建实例，一次写对无需回写）+ run_solder_import 后台管线：download-mods(25) download_batch 并行下 30 个 zip（落盘名 {序号:04}-{清洗后mod名}.zip 保序防注入）→ verify(5) MD5 硬失败（TECHNIC_SOLDER_MD5_MISMATCH，大小写不敏感比对）→ extract-merge(10) 按清单顺序解压叠加（后者覆盖前者，z- 前缀配置包排末尾最后覆盖是 Technic 约定）→ install-game(40) run_install_pipeline 装 vanilla（loader 置 None）→ copy-files(15) 复用 copy_technic_content（顶层 bin/ 不拷）→ jarmod(5) bin/modpack.jar 存在则复用 install_technic_jarmod（期2-B 机制注入 Forge/FML）。实例元数据 loader=forge/loaderVersion=164 仅作标注；modpackVersion 记录所选 build。新增错误码：TECHNIC_SOLDER_NO_BUILDS / TECHNIC_SOLDER_BUILD_NOT_FOUND / TECHNIC_SOLDER_BUILD_INVALID / TECHNIC_SOLDER_MD5_MISMATCH / TECHNIC_SOLDER_NOT_DISTRIBUTED；TECHNIC_SOLDER_UNSUPPORTED 保留改义为「无任何可用分发」。前端零改动。build 选择 MVP 自动装 recommended（缺失回退 latest），build 列表 UI 露出为后续增强。

## 备选方案

### 方案 方案 B：服务端拼合 SingleZip 喂现有管线
- 优点：零新管线
- 缺点：双倍磁盘 I/O；parse_technic_zip 会因无 version.json/fmlversion.properties 报 TECHNIC_ANCIENT_PACK_NO_VERSION（需再开特例）；本质绕路。
- 为何不选：否决

### 方案 方案 C：前端编排逐文件下载
- 优点：后端零改动
- 缺点：违反后端代理安装原则（决策③），开放任意 URL 下载面；进度/校验/清理逻辑无法复用后端管线。
- 为何不选：直接排除

### 方案 为 1.2.5 补 Forge installer 安装路径
- 优点：loader 管线统一
- 缺点：极老版本在官方/BMCLAPI 通道上可靠性未知；Tekkit 实测证明 modpack.jar 内含 Forge 本体，jarmod 即可。
- 为何不选：不采用（暂缓）

## 影响
- qomicex-core-rust/src/models/expansion/technic.rs
- qomicex-core-rust/src/api/expansion.rs
- qomicex-core-rust/src/services/expansion/technic/query.rs
- src-backend/qomicex-backend/src/endpoints/modpack.rs
- docs/junsi-dev-docs/3-API规范/API列表.md（错误码）
- docs/junsi-dev-docs/2-架构设计/Technic-整合包支持-实现地图与排障.md（§0/§9 状态更新）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-05 | v1.0 | 初版创建 | AI Agent |