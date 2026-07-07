# Task 3: QmlProtocols 自定义协议注册表

**Files:**
- Create: `src-backend/Qomicex.Launcher.Backend/Services/Connector/QmlProtocols.cs`

**Interfaces:**
- Consumes: `Qomicex.Connector.Protocols.{IProtocol, DelegateProtocol}`、`Qomicex.Connector.Guest.ScaffoldingGuest`（`SendAsync<TResp>`、`SendAsync<TReq,TResp>`）。参考 `src-backend/Qomicex.Connector.Part.Scaffolding/README.md` 第六节。
- Produces:
  - DTO：`GameInfoDto { string GameVersion; string? Loader; string? LoaderVersion; }`
  - DTO：`PlayerIconUpload { string MachineId; string IconBase64; }`
  - DTO：`PlayerIconMap { Dictionary<string,string> Icons; }`
  - `static string[] GuestKeys` = `["qml:game_info", "qml:player_icons"]`
  - `static IProtocol[] BuildHostProtocols(Func<GameInfoDto> getGameInfo, Func<PlayerIconUpload, PlayerIconMap> exchangeIcons)`
  - `static Task<GameInfoDto?> FetchGameInfoAsync(ScaffoldingGuest guest, CancellationToken ct)`
  - `static Task<PlayerIconMap?> ExchangeIconsAsync(ScaffoldingGuest guest, PlayerIconUpload upload, CancellationToken ct)`

- [ ] **Step 1: 创建 QmlProtocols.cs**

```csharp
using Qomicex.Connector.Guest;
using Qomicex.Connector.Protocols;

namespace Qomicex.Launcher.Backend.Services.Connector;

public sealed class GameInfoDto
{
    public string GameVersion { get; set; } = "";
    public string? Loader { get; set; }
    public string? LoaderVersion { get; set; }
}

public sealed class PlayerIconUpload
{
    public string MachineId { get; set; } = "";
    public string IconBase64 { get; set; } = "";
}

public sealed class PlayerIconMap
{
    public Dictionary<string, string> Icons { get; set; } = new();
}

/// <summary>
/// qml 命名空间自定义协议集中注册表。新增协议：在此加键名常量、DTO、
/// BuildHostProtocols 里的一个 DelegateProtocol、GuestKeys 里的键、以及一个 Guest 调用封装。
/// </summary>
public static class QmlProtocols
{
    public const string GameInfoKey = "qml:game_info";
    public const string PlayerIconsKey = "qml:player_icons";

    public static readonly string[] GuestKeys = [GameInfoKey, PlayerIconsKey];

    public static IProtocol[] BuildHostProtocols(
        Func<GameInfoDto> getGameInfo,
        Func<PlayerIconUpload, PlayerIconMap> exchangeIcons)
    {
        return
        [
            new DelegateProtocol<GameInfoDto>(GameInfoKey, getGameInfo),
            new DelegateProtocol<PlayerIconUpload, PlayerIconMap>(PlayerIconsKey, exchangeIcons),
        ];
    }

    public static Task<GameInfoDto?> FetchGameInfoAsync(ScaffoldingGuest guest, CancellationToken ct = default)
        => guest.SendAsync<GameInfoDto>(GameInfoKey, ct);

    public static Task<PlayerIconMap?> ExchangeIconsAsync(ScaffoldingGuest guest, PlayerIconUpload upload, CancellationToken ct = default)
        => guest.SendAsync<PlayerIconUpload, PlayerIconMap>(PlayerIconsKey, upload, ct);
}
```

- [ ] **Step 2: 验证 build**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded。若报 `DelegateProtocol<T>` 构造签名不符，核对 `src-backend/Qomicex.Connector.Part.Scaffolding/Qomicex.Connector/Protocols/IProtocol.cs` 中的重载并调整。

- [ ] **Step 3: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/Connector/QmlProtocols.cs
git commit -m "feat: add QmlProtocols registry for custom connector protocols"
```
