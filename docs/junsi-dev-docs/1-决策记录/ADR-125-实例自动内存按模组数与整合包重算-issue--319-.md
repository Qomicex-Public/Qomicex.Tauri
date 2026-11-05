# ADR-125：实例自动内存按模组数与整合包重算（issue #319）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-11-05 |
| 决策者 | AI Agent |

## 背景

大型整合包（如 400 mods）自动分配不到 4GB，几乎无法游玩。根因：新建/安装入口硬编码 4096，实例自动公式仅按可用内存 70% 且未持久化内存模式。

## 决策

GameInstance 增加 memoryMode（缺失/null=auto，写入 qomicex.json）；后端 auto_memory 统一公式：rawCap=floor((整合包?总内存:可用内存)*0.7)，cap=max(1024,rawCap)，desired=1536+12*mods+(整合包?512:0)，capped=min(max(desired,2048),cap)，result=max(min(round256(capped),floor(cap/256)*256),1024)；cap<2048 时结果允许低于 2048，但不会低于 1024。auto 模式每次启动前重算并落盘；新增 GET /instance/{id}/memory-recommendation 供实例设置页“自动”按钮使用。模组计数含 .jar 与 .jar.disabled。

## 备选方案

### 方案 前端三处重复公式
- 优点：无需新增接口
- 缺点：易漂移，启动链路仍需后端实现
- 为何不选：舍弃

### 方案 仅改全局默认内存
- 优点：改动最小
- 缺点：不解决安装入口固定 4096 与模组数影响
- 为何不选：舍弃

### 方案 按模组数分档固定值
- 优点：直观
- 缺点：边界跳变，小内存机器容易 OOM
- 为何不选：舍弃

## 影响
- src-backend/qomicex-backend/src/services/auto_memory.rs（新增）
- src-backend/qomicex-backend/src/services/instance.rs
- src-backend/qomicex-backend/src/services/instance_config.rs
- src-backend/qomicex-backend/src/endpoints/instance.rs
- src/types/index.ts
- src/api/instance.ts
- src/pages/InstanceDetail.tsx

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-11-05 | v1.0 | 初版创建 | AI Agent |