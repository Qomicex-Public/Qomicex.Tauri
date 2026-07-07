# Task 1: 后端引用 submodule 项目

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`

**Interfaces:**
- Consumes: submodule 项目 `src-backend/Qomicex.Connector.Part.Scaffolding/Qomicex.Connector/Qomicex.Connector.csproj`。
- Produces: 后端可 `using Qomicex.Connector;` 及其子命名空间。

- [ ] **Step 1: 添加 ProjectReference**

在 `Qomicex.Launcher.Backend.csproj` 里已有的 `<ItemGroup>`（含 `Qomicex.Core` 的那个）中追加：

```xml
  <ItemGroup>
    <ProjectReference Include="..\..\Qomicex.Avalonia\Qomicex.Core\Qomicex.Core.csproj" />
    <ProjectReference Include="..\Qomicex.Connector.Part.Scaffolding\Qomicex.Connector\Qomicex.Connector.csproj" />
  </ItemGroup>
```

- [ ] **Step 2: 验证 build**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: 编译成功（Build succeeded），无关于 `Qomicex.Connector` 的引用错误。

- [ ] **Step 3: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj
git commit -m "build: reference Qomicex.Connector submodule from backend"
```
