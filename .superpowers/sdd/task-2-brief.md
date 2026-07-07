# Task 2: ScaffoldingException 异常映射

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Middleware/ErrorHandlingMiddleware.cs`

**Interfaces:**
- Consumes: `Qomicex.Connector.RoomCodeInvalidException`、`Qomicex.Connector.ScaffoldingException`（基类，见 `src-backend/Qomicex.Connector.Part.Scaffolding/Qomicex.Connector/ScaffoldingException.cs`）。
- Produces: 无（仅错误码映射）。

- [ ] **Step 1: 加 using**

在文件顶部 using 区加：

```csharp
using Qomicex.Connector;
```

- [ ] **Step 2: 在 MapException 的 switch 中，`ApiException` 之后插入两条分支**

在 `ApiException api => (...)` 行之后、`ArgumentNullException` 行之前插入：

```csharp
            RoomCodeInvalidException => (400, "ROOM_CODE_INVALID", ex.Message, null),
            ScaffoldingException => (502, "CONNECTOR_ERROR", ex.Message, ex.InnerException?.Message),
```

（`RoomCodeInvalidException` 必须排在 `ScaffoldingException` 之前，因为它是子类。）

- [ ] **Step 3: 验证 build**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded。

- [ ] **Step 4: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Middleware/ErrorHandlingMiddleware.cs
git commit -m "feat: map ScaffoldingException to HTTP errors"
```
