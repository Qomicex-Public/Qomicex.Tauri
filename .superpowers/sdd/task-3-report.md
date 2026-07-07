# Task 3 Report: QmlProtocols 自定义协议注册表

## What I implemented
Created `src-backend/Qomicex.Launcher.Backend/Services/Connector/QmlProtocols.cs` (new `Services/Connector/` directory) with:
- DTOs: `GameInfoDto`, `PlayerIconUpload`, `PlayerIconMap`
- `QmlProtocols` static class: `GameInfoKey`/`PlayerIconsKey` consts, `GuestKeys` array, `BuildHostProtocols(...)`, `FetchGameInfoAsync(...)`, `ExchangeIconsAsync(...)`.
- Namespace: `Qomicex.Launcher.Backend.Services.Connector`.
- One XML doc summary only (no extra comments).

## Signature deviations
None. Verified against library source:
- `DelegateProtocol<TResp>(string, Func<TResp>, JsonSerializerOptions? = null)` — matches (options optional).
- `DelegateProtocol<TReq, TResp>(string, Func<TReq, TResp>, JsonSerializerOptions? = null)` — matches.
- `ScaffoldingGuest.SendAsync<TResp>(string, CancellationToken)` → `Task<TResp?>` — matches, nullable return aligns with `FetchGameInfoAsync` returning `Task<GameInfoDto?>`.
- `ScaffoldingGuest.SendAsync<TReq, TResp>(string, TReq, CancellationToken)` → `Task<TResp?>` — matches.

Brief code compiled verbatim with no adjustment needed.

## Build result
`dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`: **Build succeeded — 0 errors, 9 warnings** (all pre-existing, unrelated to this file: nullability CS86xx + CA1416 in AccountController/ModpackService/JavaDownloadService).

## Files changed
- Added: `src-backend/Qomicex.Launcher.Backend/Services/Connector/QmlProtocols.cs` (51 lines)

## Self-review
- Namespace correct; imports `Qomicex.Connector.Guest` + `Qomicex.Connector.Protocols` resolve.
- No comments beyond the one required XML summary.
- Nullable return types on Fetch/Exchange consistent with underlying `SendAsync` returning `TResp?`.
- Collection-expression syntax (`[...]`) valid for C# / .NET 10 target.

## Concerns
- Git reported LF→CRLF normalization warning on commit; cosmetic only, no impact.
- File uses LF line endings; repo may normalize to CRLF later.
