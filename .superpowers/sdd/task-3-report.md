## Task 3 Report: InstanceFilesController Mod 端点

### 状态: ✅ 完成

### 修改内容

**文件:** `src-backend/Qomicex.Launcher.Backend/Controllers/InstanceFilesController.cs`

1. 添加 using: `Qomicex.Core.Modules.Helpers.Resources.Expansion.Local`
2. 构造函数注入 2 个新依赖: `McmodService`, `IConfiguration`
3. 新增 7 个 API 端点:

| 方法 | 路由 | 描述 |
|------|------|------|
| GET | `mods/metadata` | 获取 mod 列表并附加元数据（中文名、来源、图标等） |
| POST | `mods/enable` | 启用指定 mod |
| POST | `mods/disable` | 禁用指定 mod |
| POST | `mods/change-version` | 更换 mod 版本（删除旧文件 + 下载新文件） |
| POST | `mods/batch-enable` | 批量启用 mod |
| POST | `mods/batch-disable` | 批量禁用 mod |
| POST | `mods/batch-delete` | 批量删除 mod |

### 编译结果

Build succeeded. 0 warnings, 0 errors.

### Commit

```
ddf2ad1 feat: add mod metadata, enable/disable, change-version, batch endpoints
1 file changed, 180 insertions(+), 1 deletion(-)
```

### 偏差说明

- `IconUrl` 初始代码使用了 `m.CurseFoegeMeta?.IconUrl`，但 `CurseForgeFilesMeta` 类没有 `IconUrl` 属性。修改为仅使用 `m.ModrinthMeta?.IconUrl`（CurseForge mod 的图标需后续从搜索结果或其他接口获取）。
