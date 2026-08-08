# Batch Plan: Full Migration C# → Rust + Axum→IPC

## Dependency Graph (DAG)

```
Batch 1: models, traits, error types (zero dependencies)
  ↓
Batch 2: services (depend on models + traits)
  ├── auth, accounts, settings, crypt
  ├── instance, java_provider, installer_provider
  ├── download_source, resource_completer, version
  ├── launch, install_tracker
  └── skin, mcmod
  ↓
Batch 3: expansion clients (depend on services)
  ├── modrinth
  ├── curseforge
  ├── ftb
  └── local
  ↓
Batch 4: installers (depend on expansion + services)
  ↓
Batch 5: connectors (depend on submodule migration)
  ↓
Batch 6: IPC commands (depend on all services, replaces Axum)
```

## Phase I: Fix Stubs in Axum Layer (existing handlers)

| Batch | Package | Files | Work | Est. Lines |
|-------|---------|-------|------|-----------|
| 1a | **Settings** | `api_server/mod.rs` | Add real Java download, background files, open-folder, cache clear | 120 |
| 1b | **Java store** | `api_server/mod.rs` + `services/java_provider.rs` | Implement custom Java path CRUD (JavaRuntimeStore), validate Java | 150 |
| 1c | **Diagnostics** | `api_server/mod.rs` | Real trace buffer + dump, diagnostics health ping | 100 |
| 1d | **Resource fetch** | `api_server/mod.rs` | Wire CurseForgeVersionFetchService for real CF version listing | 180 |
| 1e | **Resource download** | `api_server/mod.rs` | Real download via reqwest (replace fake DOWNLOAD_TASKS) | 200 |
| 1f | **Connector stub** | `api_server/mod.rs` + `connector/` | Wire connector_status to real ConnectorService | 50 |
| 1g | **License** | `api_server/mod.rs` | Real license validate/activate with machine code + HTTP | 120 |
| 1h | **Announcements** | `api_server/mod.rs` | Proxy QomicexWeb API | 50 |
| 1i | **Mods check-updates** | `api_server/mod.rs` | Check mod versions against Modrinth/CF | 150 |
| 1j | **Server ping** | `api_server/mod.rs` | Real Minecraft server ping (handshake protocol) | 120 |
| 1k | **LAN games** | `api_server/mod.rs` + `connector/` | Real UDP multicast listener | 120 |
| 1l | **Save copy** | `api_server/mod.rs` | Real directory copy | 30 |
| 1m | **Missing endpoints** | `api_server/mod.rs` | Add: launch/kill, version/install/uninstall, resource/complete, logs export/delete, translate | 250 |

## Phase II: Axum→IPC Conversion

| Batch | Package | Files | Work | Est. Lines |
|-------|---------|-------|------|-----------|
| 2a | **Auth commands** | `commands/auth_commands.rs` | ADD: yggdrasil_auth, yggdrasil_select, tongyi, auth_validate, auth_invalidate, auth_refresh | 250 |
| 2b | **Instance files commands** | `commands/instance_commands.rs` (new file: `commands/instance_files_commands.rs`) | MOVE all instance file handlers from api_server to commands | 400 |
| 2c | **Java commands** | `commands/java_commands.rs` (new) | MOVE all Java handlers | 300 |
| 2d | **System commands** | `commands/system_commands.rs` | ADD: system_info, diagnostics, settings, logs | 350 |
| 2e | **Connector commands** | `commands/connector_commands.rs` (new) | MOVE connector handlers | 150 |
| 2f | **Resource commands** | `commands/resource_commands.rs` (new) | MOVE resource center + resource download handlers | 350 |
| 2g | **Skin commands** | `commands/skin_commands.rs` (new) | MOVE skin handlers | 100 |
| 2h | **Update commands** | `commands/update_commands.rs` (new) | MOVE update check/manifest | 100 |

**After Batch 2: Remove `api_server/mod.rs` and `call_api` bridge from `lib.rs`**

## Phase III: Frontend Migration

| Batch | Package | Work |
|-------|---------|------|
| 3a | `src/api/client.ts` | Replace fetch/ApiError with Tauri invoke calls |
| 3b | All stores/hooks | Replace HTTP calls with IPC |

## Phase IV: Connector Submodule Migration (Scaffolding)

| Batch | Package | Files | Work | Est. Lines |
|-------|---------|-------|------|-----------|
| 4a | **Protocol** | `connector/protocol.rs` (new) | ProtocolFrame serialization, ProtocolNegotiator, ProtocolSerializer | 300 |
| 4b | **Center** | `connector/center.rs` (new) | ScaffoldingCenter, TcpServer, CenterDiscoveryService | 400 |
| 4c | **Guest** | `connector/guest.rs` (new) | ScaffoldingGuest, TcpClient, HeartbeatService | 350 |
| 4d | **Service** | `connector/service.rs` | Full ConnectorService with ScaffoldingClient integration | 250 |
| 4e | **EasyTier** | `connector/easy_tier.rs` | Real EasyTier download/status (was stub) | 150 |
| 4f | **NAT** | `connector/nat_detection.rs` | Real STUN NAT type detection (was stub) | 200 |

## Phase V: Core.Rust Crate (Core.AOT migration)

| Batch | Package | Files | Work | Est. Lines |
|-------|---------|-------|------|-----------|
| 5a | **Crate setup** | `core/Cargo.toml`, `core/src/lib.rs`, `core/src/traits.rs` | Create new `qomicex-core` crate with trait definitions | 100 |
| 5b | **Models extraction** | `core/src/models/*.rs` | Move models from app/ to core/ | 300 |
| 5c | **Auth impl** | `core/src/auth.rs` | Move auth service to core | 200 |
| 5d | **Version service** | `core/src/version.rs`, `resource_completer.rs` | Move version mgmt + resource completer | 350 |
| 5e | **Java provider** | `core/src/java.rs` | Move JavaProviderService | 200 |
| 5f | **Installer provider + installers** | `core/src/installer/` | Move installer_provider + all installers | 500 |
| 5g | **Expansion clients** | `core/src/expansion/` | Move Modrinth/CurseForge/FTB/Local | 600 |
| 5h | **Launch executor** | `core/src/launch.rs` | Move MinecraftLauncher | 300 |
| 5i | **Options + Server** | `core/src/options.rs`, `core/src/server.rs` | OptionsProvider, ServerManager, NBT | 400 |

## Legacy: Items for Human Decision

| # | Item | Reason |
|---|------|--------|
| H1 | `MAPPING_TABLE.yaml` version management | How to keep in sync as migration progresses |
| H2 | Core.Rust workspace integration | Workspace dependency or git submodule? |
| H3 | Frontend API client rewrite | Replace all `src/api/client.ts` with Tauri invoke |
| H4 | NBT parser for servers.dat | Need Rust NBT lib (simdnbt requires nightly) |
| H5 | `QOMICEX_USE_AXUM` env var | Remove after migration, simplify startup logic in `lib.rs` |
