### Task 5: InstanceInstallService GetAllActiveStates — Report

**状态:** 完成

**提交:**
- `dab8f7f` — `feat(install): add GetAllActiveStates to InstanceInstallService`
- 修改文件: `src-backend/Qomicex.Launcher.Backend/Services/InstanceInstallService.cs` (+21 行)

**构建结果:** 成功 (0 errors, 7 warnings — 均为预先存在的警告，与本次修改无关)

**自我审查:**
- 方法签名、过滤条件、映射字段均与 brief 一致
- 已添加 `using System.Linq;`
- 过滤逻辑正确排除 `completed`/`cancelled`/`failed` 状态和已完成的任务
- `StartedAt` 未在映射中设置（brief 中的代码也未包含），与 `GetState` 不同，符合预期

**关注点:** 无
