# Neo Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create `Qomicex.Launcher.Backend.Neo` — ASP.NET Core Minimal API + NativeAOT — using completed features from `Qomicex.Core.AOT`.

**Architecture:** One .cs file per API domain (auth/versions/launch/resources/instances/system) using extension methods. Core.AOT provides version management, resource completion, launch execution, and auth. Backend manages GameInstance CRUD via JSON files.

**Tech Stack:** .NET 10, ASP.NET Core Minimal API, NativeAOT (PublishAot=true), System.Text.Json source gen, Qomicex.Core.AOT, Qomicex.Downloader.

## Global Constraints

- Target: `net10.0`, `PublishAot=true`, `IsAotCompatible=true`
- All JSON must use source generators (no reflection-based serializer)
- GameInstance model must be compatible with old backend JSON files
- Error response format must match old backend: `{ code, message, detail, traceId, timestamp, status }`
- Port: 5000 (same as old backend)
- CORS: AllowAnyOrigin/AllowAnyHeader/AllowAnyMethod
- Kestrel max body: 500 MB
- Do NOT reference Qomicex.Connector or old Qomicex.Core

---

### Task 1: Project scaffolding

**Files:**
- Create: `src-backend/Qomicex.Launcher.Backend.Neo/Qomicex.Launcher.Backend.Neo.csproj`
- Create: `src-backend/Qomicex.Launcher.Backend.Neo/Qomicex.Launcher.Backend.Neo.slnx`
- Create: directory structure (`Models/`, `Endpoints/`, `Services/`, `Middleware/`, `JsonContext/`)

**Interfaces:**
- Produces: compilable project structure (no business logic)

- [ ] **Create directory structure**

```bash
mkdir -p /run/media/lenmei233/ECA48B49A48B14EC/qomicex-launcher/src-backend/Qomicex.Launcher.Backend.Neo/{Models,Endpoints,Services,Middleware,JsonContext}
```

- [ ] **Write Qomicex.Launcher.Backend.Neo.csproj**

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>Qomicex.Launcher.Backend.Neo</RootNamespace>
    <PublishAot>true</PublishAot>
    <EnableAotAnalyzer>true</EnableAotAnalyzer>
    <IsAotCompatible>true</IsAotCompatible>
  </PropertyGroup>
  <ItemGroup>
    <EmbeddedResource Include="appsettings.json" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="..\Qomicex.Core.AOT\Qomicex.Core.AOT\Qomicex.Core.AOT.csproj" />
    <ProjectReference Include="..\Qomicex.Downloader\Qomicex.Downloader.csproj" />
  </ItemGroup>
</Project>
```

- [ ] **Write Qomicex.Launcher.Backend.Neo.slnx**

```xml
<Solution>
  <Project Path="Qomicex.Launcher.Backend.Neo.csproj" />
</Solution>
```

- [ ] **Write appsettings.json**

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning"
    }
  },
  "AllowedHosts": "*",
  "Kestrel": {
    "Endpoints": {
      "Http": {
        "Url": "http://localhost:5000"
      }
    }
  }
}
```

---

### Task 2: Core models & JSON source gen context

**Files:**
- Create: `Models/GameInstance.cs`
- Create: `Models/ApiError.cs`
- Create: `JsonContext/ApiJsonContext.cs`

**Interfaces:**
- Produces: `GameInstance`, `ApiError` classes; `ApiJsonContext` source generator

- [ ] **Write Models/GameInstance.cs** (compatible with old backend)
- [ ] **Write Models/ApiError.cs** (same format as old backend)
- [ ] **Write JsonContext/ApiJsonContext.cs** (source gen for all API DTOs)

---

### Task 3: Error handling middleware

**Files:**
- Create: `Middleware/ErrorHandlingMiddleware.cs`

**Interfaces:**
- Produces: `ErrorHandlingMiddleware` class + `UseErrorHandling()` extension

- [ ] **Write Middleware/ErrorHandlingMiddleware.cs** (adapted from old backend, no Connector dependency)

---

### Task 4: Instance service

**Files:**
- Create: `Services/InstanceService.cs`

**Interfaces:**
- Produces: `InstanceService` (singleton) with CRUD methods matching old backend patterns

- [ ] **Write Services/InstanceService.cs** (JSON file at `{BaseDir}/data/instances.json`, thread-safe)

---

### Task 5: Program.cs — Entry point

**Files:**
- Create: `Program.cs`

**Interfaces:**
- Consumes: all services, middleware, and endpoint groups from other tasks
- Produces: running ASP.NET Core application

- [ ] **Write Program.cs**
  - Load embedded appsettings.json
  - Configure Kestrel (500 MB)
  - Build Core.AOT `DefaultGameCore` via `GameCoreBuilder`
  - Register all services
  - Register CORS
  - Register middleware pipeline
  - Map all endpoint groups

---

### Task 6: Auth endpoints

**Files:**
- Create: `Endpoints/AuthEndpoints.cs`

**Interfaces:**
- Consumes: `IAuthProvider` (from Core.AOT DefaultGameCore)
- Produces: `MapAuthEndpoints()` extension method

- [ ] **Write Endpoints/AuthEndpoints.cs**
  - `POST /api/auth/offline` → `DefaultAuthProvider.AuthenticateAsync`
  - `POST /api/auth/microsoft/device-code` → `MicrosoftAuthProvider.StartDeviceCodeAsync`
  - `POST /api/auth/microsoft/poll` → `MicrosoftAuthProvider.PollForTokenAsync`
  - `POST /api/auth/yggdrasil` → `YggdrasilAuthProvider.AuthenticateAsync`
  - `POST /api/auth/validate` → `IAuthProvider.ValidateAsync`
  - `POST /api/auth/invalidate` → `IAuthProvider.InvalidateAsync`

---

### Task 7: Version endpoints

**Files:**
- Create: `Endpoints/VersionEndpoints.cs`

**Interfaces:**
- Consumes: `IVersionManagementService`, `IVersionManifestService` (from Core.AOT)
- Produces: `MapVersionEndpoints()` extension method

- [ ] **Write Endpoints/VersionEndpoints.cs**
  - `GET /api/versions` → available versions (from manifest)
  - `GET /api/versions/{name}` → version metadata
  - `GET /api/versions/installed` → installed local versions
  - `POST /api/versions/{name}/install` → install version
  - `POST /api/versions/{name}/uninstall` → uninstall version

---

### Task 8: Launch endpoints

**Files:**
- Create: `Endpoints/LaunchEndpoints.cs`

**Interfaces:**
- Consumes: `ILaunchExecutor` (from Core.AOT)
- Produces: `MapLaunchEndpoints()` extension method

- [ ] **Write Endpoints/LaunchEndpoints.cs**
  - `POST /api/launch` → `ILaunchExecutor.LaunchAsync`
  - `POST /api/launch/{pid}/kill` → `ILaunchExecutor.KillAsync`

---

### Task 9: Resource endpoints

**Files:**
- Create: `Endpoints/ResourceEndpoints.cs`

**Interfaces:**
- Consumes: `IResourceCompleter` (from Core.AOT, accessed via internal DefaultResourceCompleter)
- Produces: `MapResourceEndpoints()` extension method

- [ ] **Write Endpoints/ResourceEndpoints.cs**
  - `POST /api/resources/complete` → start resource completion
  - `GET /api/resources/complete/progress` → get progress

---

### Task 10: Instance endpoints

**Files:**
- Create: `Endpoints/InstanceEndpoints.cs`

**Interfaces:**
- Consumes: `InstanceService`
- Produces: `MapInstanceEndpoints()` extension method

- [ ] **Write Endpoints/InstanceEndpoints.cs**
  - `GET /api/instances` → list
  - `POST /api/instances` → create
  - `GET /api/instances/{id}` → get by id
  - `PUT /api/instances/{id}` → update
  - `DELETE /api/instances/{id}` → delete

---

### Task 11: System endpoints

**Files:**
- Create: `Endpoints/SystemEndpoints.cs`

**Interfaces:**
- Consumes: nothing special
- Produces: `MapSystemEndpoints()` extension method

- [ ] **Write Endpoints/SystemEndpoints.cs**
  - `GET /api/health` → "OK"
  - `GET /api/system/info` → OS, architecture, runtime info

---

### Task 12: Build & verify

- [ ] **Build the project**

```bash
dotnet build src-backend/Qomicex.Launcher.Backend.Neo/Qomicex.Launcher.Backend.Neo.csproj
```

Expected: Build succeeded with 0 errors, 0 warnings. AOT analyzer may produce some warnings but no errors.

- [ ] **Quick smoke test (optional)**

```bash
dotnet run --project src-backend/Qomicex.Launcher.Backend.Neo/Qomicex.Launcher.Backend.Neo.csproj &
sleep 3
curl http://localhost:5000/api/health
```

Expected: `"OK"` or similar valid response.
