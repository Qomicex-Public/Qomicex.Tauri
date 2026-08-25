# ADR-051：ADR-051: qomicex CLI 脚手架（零依赖 Node 实现 + ADR-050 签名对齐）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-25 |
| 决策者 | AI Agent |

## 背景

PHASE1 任务⑤：实现 qomicex CLI 脚手架（create/dev/pack/verify/publish），作为 monorepo 内 pnpm workspace 成员 @qomicex/cli。Node ≥ 20，纯 TypeScript，零运行时依赖。

## 决策

CLI 包放 packages/qomicex-cli 作为 pnpm workspace 成员；零运行时依赖（Node 内置 node:zlib/WebCrypto/hand-written zip CRC32 替代 fflate/archiver，手写参数解析替代 commander/yargs，手写 manifest 校验替代 zod）；签名对齐 ADR-050 规范（canonicalJson/Ed25519）；模板引用已发布的 @qomicex/plugin-ui（npm 0.2.1），生成项目自带 pnpm-workspace.yaml 自成一 workspace root 避免仓库内孤儿项目问题；根 package.json 改用 workspace:* 协议锁定本地插件包。

## 备选方案

### 方案 commander/yargs 依赖
- 优点：成熟 CLI 框架，参数解析逻辑完整
- 缺点：新增 2 个运行时依赖，与 '零依赖' 设计目标冲突
- 为何不选：未说明

### 方案 zod manifest 校验
- 优点：类型安全、schema 文档化
- 缺点：新增依赖，手写校验逻辑可覆盖同样场景（~50 行）
- 为何不选：未说明

## 影响
- packages/qomicex-cli/ 新目录（~500 行 TS）
- package.json 根增加 @qomicex/plugin-ui workspace:* 协议
- pnpm-workspace.yaml 无变动
- pnpm-lock.yaml 新增 CLI importer + @types/node
- 模板生成的项目可独立 pnpm install && build 通过

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-25 | v1.0 | 初版创建 | AI Agent |