using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Qomicex.Core.AOT.Models.Expansion.Local;
using Qomicex.Core.AOT.Services.Expansion.Local;
using Qomicex.Core.AOT.Services.Options;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Models;
using Qomicex.Launcher.Backend.Neo.Services;

namespace Qomicex.Launcher.Backend.Neo.Endpoints;

public static class InstanceFilesEndpoints
{
    private static readonly ConcurrentDictionary<string, ModLoadProgress> ModLoadProgressStore = new();

    public static void MapInstanceFilesEndpoints(this WebApplication app, string curseForgeApiKey)
    {
        var group = app.MapGroup("/api/instance/{id}/files");

        MapModEndpoints(group, curseForgeApiKey);
        MapResourcepackEndpoints(group);
        MapShaderpackEndpoints(group);
        MapDataPackEndpoints(group);
        MapScreenshotEndpoints(group);
        MapSaveEndpoints(group);
        MapServerEndpoints(group);
        MapOptionsEndpoints(group);
    }

    private static (string GameDir, string Version, bool Isolated) Resolve(
        string id, InstanceService instances)
    {
        var inst = instances.GetById(id)
            ?? throw ApiException.NotFound($"Instance {id} not found");
        var isolated = inst.VersionIsolation ?? SystemEndpoints.GetGlobalVersionIsolation();
        // 版本隔离：基于游戏根目录，由 GetCategoryDir 再拼 versions/{version}；
        // 非隔离：ResolvedGameDir 本身就是实际游戏目录（可能已指向 versions/xxx）
        var gameDir = isolated
            ? Path.GetFullPath(inst.GameDir)
            : Path.GetFullPath(inst.ResolvedGameDir ?? inst.GameDir);
        var version = inst.VersionDirName ?? inst.Name;
        return (gameDir, version, isolated);
    }

    private static string GetCategoryDir(string gameDir, string version, bool isolated, string sub)
    {
        var full = isolated
            ? Path.Combine(gameDir, "versions", version, sub)
            : Path.Combine(gameDir, sub);
        if (!Directory.Exists(full))
            Directory.CreateDirectory(full);
        return full;
    }

    private static List<FileEntryDto> GetFileEntries(string dir)
    {
        if (!Directory.Exists(dir)) return [];

        var files = new List<FileEntryDto>();
        foreach (var d in Directory.GetDirectories(dir))
        {
            files.Add(new FileEntryDto
            {
                Name = Path.GetFileName(d),
                IsDirectory = true,
                LastModified = Directory.GetLastWriteTime(d),
                Created = Directory.GetCreationTime(d)
            });
        }
        foreach (var f in Directory.GetFiles(dir))
        {
            var fi = new FileInfo(f);
            files.Add(new FileEntryDto
            {
                Name = fi.Name,
                Size = fi.Length,
                IsDirectory = false,
                LastModified = fi.LastWriteTime,
                Created = fi.CreationTime,
                Extension = fi.Extension.ToLower()
            });
        }
        return files;
    }

    // ──────── Mods ────────

    private static void MapModEndpoints(RouteGroupBuilder group, string curseForgeApiKey)
    {
        group.MapGet("/mods", (string id, InstanceService instances) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "mods");
            return Results.Json(GetFileEntries(dir), ApiJsonContext.Default.ListFileEntryDto);
        });

        group.MapGet("/mods/count", (string id, InstanceService instances) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "mods");
            var count = Directory.Exists(dir)
                ? Directory.GetFiles(dir, "*.jar").Length + Directory.GetFiles(dir, "*.disabled").Length
                : 0;
            return Results.Ok(count);
        });

        group.MapGet("/mods/progress", (string id) =>
        {
            var p = ModLoadProgressStore.GetValueOrDefault(id);
            return Results.Json(p, ApiJsonContext.Default.ModLoadProgress);
        });

        group.MapGet("/installed-names", (string id, InstanceService instances, string? category) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var cat = (category ?? "mods").ToLowerInvariant() switch
            {
                "resourcepacks" or "resourcepack" => "resourcepacks",
                "shaderpacks" or "shader" => "shaderpacks",
                "datapacks" or "datapack" => "datapacks",
                "saves" or "save" => "saves",
                "screenshots" => "screenshots",
                _ => "mods",
            };
            var dir = GetCategoryDir(gameDir, version, isolated, cat);
            var names = Directory.Exists(dir)
                ? Directory.GetFiles(dir).Select(Path.GetFileName).Where(n => n is not null).Select(n => n!).ToList()
                : new List<string>();
            Trace.WriteLine($"[installed-names] id={id} cat={cat} dir={dir} count={names.Count}");
            return Results.Json(names, ApiJsonContext.Default.ListString);
        });

        group.MapGet("/mods/metadata", async (string id, InstanceService instances, ContentService content, McmodService mcmod, IHttpClientFactory httpFactory) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var mods = content.CreateMods(version, isolated);
            var progress = new ModLoadProgress(0, 0);
            ModLoadProgressStore[id] = progress;
            List<ModInfo> list;
            try
            {
                list = await mods.GetModList((current, total) =>
                {
                    progress.Current = current;
                    progress.Total = total;
                });
            }
            finally
            {
                ModLoadProgressStore.TryRemove(id, out _);
            }
            Trace.WriteLine($"[mods/metadata] instance={id} total={list.Count}");
            foreach (var m in list.Take(5))
            {
                Trace.WriteLine($"  [{m.Name}] CurseForgeId={m.CurseForgeId} ModrinthId={(string.IsNullOrEmpty(m.ModrinthId) ? "null" : m.ModrinthId)} CFHash={m.CFHash} Sha1Hash={m.Sha1Hash[..Math.Min(m.Sha1Hash.Length, 8)]}...");
            }
            var withCf = list.Count(m => m.CurseForgeId > 0);
            var withMr = list.Count(m => !string.IsNullOrEmpty(m.ModrinthId));
            Trace.WriteLine($"[mods/metadata] summary: withCf={withCf} withMr={withMr}");
            var result = list.Select(m =>
            {
                string? source = null;
                if (m.CurseForgeId > 0) source = "curseforge";
                else if (!string.IsNullOrEmpty(m.ModrinthId)) source = "modrinth";
                return new ModMetadataDto
                {
                    FileName = Path.GetFileName(m.FilePath),
                    Name = m.Name,
                    Version = m.Version,
                    Description = m.Description,
                    Authors = m.Authors,
                    IconBase64 = m.Icon,
                    CurseForgeId = m.CurseForgeId > 0 ? m.CurseForgeId : null,
                    ModrinthId = m.ModrinthId,
                    Source = source,
                    Active = m.Active
                };
            }).ToList();

            var names = result.Where(r => !string.IsNullOrEmpty(r.Name)).Select(r => r.Name!).ToList();
            var cnMap = mcmod.BatchLookupWithIds(names);
            foreach (var item in result)
            {
                if (!string.IsNullOrEmpty(item.Name) && cnMap.TryGetValue(item.Name, out var cn))
                {
                    item.ChineseName = cn.CnName;
                    item.McmodId = cn.Id;
                }
            }

            await FillRemoteIcons(result, httpFactory, curseForgeApiKey);

            return Results.Json(result, ApiJsonContext.Default.ListModMetadataDto);
        });

        group.MapPost("/mods/enable", (string name, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "mods");
            var mods = content.CreateMods(version, isolated);
            mods.EnableMod(Path.Combine(dir, name));
            return Results.Ok();
        });

        group.MapPost("/mods/disable", (string name, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "mods");
            var mods = content.CreateMods(version, isolated);
            mods.DisableMod(Path.Combine(dir, name));
            return Results.Ok();
        });

        group.MapDelete("/mods", async (string name, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "mods");
            var path = Path.Combine(dir, name);
            if (File.Exists(path)) File.Delete(path);
            else
            {
                var disabledPath = path + ".disabled";
                if (File.Exists(disabledPath)) File.Delete(disabledPath);
            }
            return Results.Ok();
        });

        group.MapPost("/mods/batch-enable", (List<string> names, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "mods");
            var mods = content.CreateMods(version, isolated);
            foreach (var name in names)
                mods.EnableMod(Path.Combine(dir, name));
            return Results.Ok();
        });

        group.MapPost("/mods/batch-disable", (List<string> names, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "mods");
            var mods = content.CreateMods(version, isolated);
            foreach (var name in names)
                mods.DisableMod(Path.Combine(dir, name));
            return Results.Ok();
        });

        group.MapPost("/mods/batch-delete", (List<string> names, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "mods");
            foreach (var name in names)
            {
                var path = Path.Combine(dir, name);
                if (File.Exists(path)) File.Delete(path);
                var disabledPath = path + ".disabled";
                if (File.Exists(disabledPath)) File.Delete(disabledPath);
            }
            return Results.Ok();
        });
    }

    // ──────── Resourcepacks ────────

    private static async Task FillRemoteIcons(List<ModMetadataDto> result, IHttpClientFactory httpFactory, string curseForgeApiKey)
    {
        // 本地 jar 无图标时，回退到 CF/MR 远程项目图标
        try
        {
            var noIcon = result.Where(r => string.IsNullOrEmpty(r.IconBase64)).ToList();
            if (noIcon.Count == 0) return;

            var cfIds = noIcon.Where(r => r.CurseForgeId > 0).Select(r => r.CurseForgeId!.Value).Distinct().ToList();
            if (cfIds.Count > 0 && !string.IsNullOrEmpty(curseForgeApiKey))
            {
                var body = new JsonObject
                {
                    ["modIds"] = new JsonArray(cfIds.Select(i => (JsonNode)JsonValue.Create(i)).ToArray())
                };
                using var req = new HttpRequestMessage(HttpMethod.Post, "https://api.curseforge.com/v1/mods");
                req.Headers.Add("x-api-key", curseForgeApiKey);
                req.Content = new StringContent(body.ToJsonString(), System.Text.Encoding.UTF8, "application/json");
                var resp = await httpFactory.CreateClient("CurseForge").SendAsync(req);
                if (resp.IsSuccessStatusCode)
                {
                    var data = JsonNode.Parse(await resp.Content.ReadAsStringAsync())?["data"]?.AsArray();
                    if (data is not null)
                    {
                        var iconMap = new Dictionary<int, string>();
                        foreach (var item in data)
                        {
                            var modId = item?["id"]?.GetValue<int>();
                            var logoUrl = item?["logo"]?["url"]?.GetValue<string>();
                            if (modId is int mid && !string.IsNullOrEmpty(logoUrl))
                                iconMap[mid] = logoUrl;
                        }
                        foreach (var r in noIcon)
                            if (r.IconUrl is null && r.CurseForgeId is int cid && iconMap.TryGetValue(cid, out var url))
                                r.IconUrl = url;
                    }
                }
            }

            var mrIds = noIcon.Where(r => r.IconUrl is null && !string.IsNullOrEmpty(r.ModrinthId))
                .Select(r => r.ModrinthId!).Distinct().ToList();
            if (mrIds.Count > 0)
            {
                var idsJson = new JsonArray(mrIds.Select(x => (JsonNode)JsonValue.Create(x)).ToArray()).ToJsonString();
                var resp = await httpFactory.CreateClient("Modrinth")
                    .GetAsync($"https://api.modrinth.com/v2/projects?ids={Uri.EscapeDataString(idsJson)}");
                if (resp.IsSuccessStatusCode)
                {
                    var arr = JsonNode.Parse(await resp.Content.ReadAsStringAsync())?.AsArray();
                    if (arr is not null)
                    {
                        var iconMap = new Dictionary<string, string>();
                        foreach (var item in arr)
                        {
                            var iconUrl = item?["icon_url"]?.GetValue<string>();
                            if (string.IsNullOrEmpty(iconUrl)) continue;
                            var pid = item?["id"]?.GetValue<string>();
                            var slug = item?["slug"]?.GetValue<string>();
                            if (!string.IsNullOrEmpty(pid)) iconMap[pid] = iconUrl;
                            if (!string.IsNullOrEmpty(slug)) iconMap.TryAdd(slug, iconUrl);
                        }
                        foreach (var r in noIcon)
                            if (r.IconUrl is null && !string.IsNullOrEmpty(r.ModrinthId) && iconMap.TryGetValue(r.ModrinthId, out var url))
                                r.IconUrl = url;
                    }
                }
            }
        }
        catch { /* 图标回退失败不影响元数据主流程 */ }
    }

    private static void MapResourcepackEndpoints(RouteGroupBuilder group)
    {
        group.MapGet("/resourcepacks", (string id, InstanceService instances) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "resourcepacks");
            return Results.Json(GetFileEntries(dir), ApiJsonContext.Default.ListFileEntryDto);
        });

        group.MapGet("/resourcepacks/metadata", async (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var rp = content.CreateResourcepack(version, isolated);
            var list = await rp.GetResourcePackList();
            var result = list.Select(r => new ResourcePackMetadataDto
            {
                FileName = Path.GetFileName(r.FilePath),
                Name = r.Name,
                Description = r.Description,
                Version = r.Version,
                PackFormat = r.PackFormat,
                IconBase64 = r.Icon,
                CurseForgeId = r.CurseForgeId > 0 ? r.CurseForgeId : null,
                ModrinthId = r.ModrinthId
            }).ToList();
            return Results.Json(result, ApiJsonContext.Default.ListResourcePackMetadataDto);
        });

        group.MapDelete("/resourcepacks", (string name, string id, InstanceService instances) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "resourcepacks");
            var path = Path.Combine(dir, name);
            if (File.Exists(path)) File.Delete(path);
            return Results.Ok();
        });
    }

    // ──────── Shaderpacks ────────

    private static void MapShaderpackEndpoints(RouteGroupBuilder group)
    {
        group.MapGet("/shaderpacks", (string id, InstanceService instances) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "shaderpacks");
            return Results.Json(GetFileEntries(dir), ApiJsonContext.Default.ListFileEntryDto);
        });

        group.MapGet("/shaderpacks/metadata", async (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var s = content.CreateShaders(version, isolated);
            var list = await s.GetShaderList();
            var result = list.Select(s2 => new ShaderMetadataDto
            {
                FileName = Path.GetFileName(s2.FilePath),
                Name = s2.Name,
                Description = s2.Description,
                Version = s2.Version,
                IconBase64 = s2.Icon,
                CurseForgeId = s2.CurseForgeId > 0 ? s2.CurseForgeId : null,
                ModrinthId = s2.ModrinthId
            }).ToList();
            return Results.Json(result, ApiJsonContext.Default.ListShaderMetadataDto);
        });

        group.MapDelete("/shaderpacks", (string name, string id, InstanceService instances) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "shaderpacks");
            var path = Path.Combine(dir, name);
            if (File.Exists(path)) File.Delete(path);
            return Results.Ok();
        });
    }

    // ──────── DataPacks ────────

    private static void MapDataPackEndpoints(RouteGroupBuilder group)
    {
        group.MapGet("/datapacks", (string id, InstanceService instances) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "datapacks");
            return Results.Json(GetFileEntries(dir), ApiJsonContext.Default.ListFileEntryDto);
        });

        group.MapGet("/datapacks/metadata", async (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dp = content.CreateDataPacks(version, isolated);
            var list = await dp.GetDataPackList();
            var result = list.Select(d => new DataPackMetadataDto
            {
                FileName = Path.GetFileName(d.FilePath),
                Name = d.Name,
                Description = d.Description,
                Version = d.Version,
                PackFormat = d.PackFormat,
                IconBase64 = d.Icon,
                CurseForgeId = d.CurseForgeId > 0 ? d.CurseForgeId : null,
                ModrinthId = d.ModrinthId
            }).ToList();
            return Results.Json(result, ApiJsonContext.Default.ListDataPackMetadataDto);
        });

        group.MapDelete("/datapacks", (string name, string id, InstanceService instances) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "datapacks");
            var path = Path.Combine(dir, name);
            if (File.Exists(path)) File.Delete(path);
            return Results.Ok();
        });
    }

    // ──────── Screenshots ────────

    private static void MapScreenshotEndpoints(RouteGroupBuilder group)
    {
        group.MapGet("/screenshots", (string id, InstanceService instances) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "screenshots");
            return Results.Json(GetFileEntries(dir), ApiJsonContext.Default.ListFileEntryDto);
        });

        group.MapGet("/screenshots/metadata", (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var sc = content.CreateScreenshots(version, isolated);
            var list = sc.GetScreenshotList();
            var result = list.Select(s => new ScreenshotMetadataDto
            {
                FileName = s.FileName,
                FilePath = s.FilePath,
                CreatedAt = s.CreatedAt,
                FileSize = s.FileSize
            }).ToList();
            return Results.Json(result, ApiJsonContext.Default.ListScreenshotMetadataDto);
        });

        group.MapGet("/screenshots/{fileName}", (string id, string fileName, InstanceService instances) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "screenshots");
            var path = Path.Combine(dir, fileName);
            if (!File.Exists(path)) return Results.NotFound();
            return Results.File(path, "image/png");
        });

        group.MapDelete("/screenshots", (string name, string id, InstanceService instances) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "screenshots");
            var path = Path.Combine(dir, name);
            if (File.Exists(path)) File.Delete(path);
            return Results.Ok();
        });
    }

    // ──────── Saves ────────

    private static void MapSaveEndpoints(RouteGroupBuilder group)
    {
        group.MapGet("/saves", (string id, InstanceService instances) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var dir = GetCategoryDir(gameDir, version, isolated, "saves");
            return Results.Json(GetFileEntries(dir), ApiJsonContext.Default.ListFileEntryDto);
        });

        group.MapGet("/saves/metadata", (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var saves = content.CreateSaves(version, isolated);
            var list = saves.GetSaveList();
            var result = list.Select(s => new SaveMetadataDto
            {
                Name = s.Name,
                FilePath = s.FilePath,
                LastPlayed = s.LastPlayed,
                IconBase64 = s.Icon
            }).ToList();
            return Results.Json(result, ApiJsonContext.Default.ListSaveMetadataDto);
        });

        group.MapPost("/saves/copy", (SaveCopyRequestDto req, string id, InstanceService instances) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var savesDir = GetCategoryDir(gameDir, version, isolated, "saves");
            var src = Path.Combine(savesDir, req.Name);
            var dst = Path.Combine(savesDir, req.NewName);
            if (!Directory.Exists(src)) return Results.NotFound();
            CopyDirectory(src, dst);
            return Results.Ok();
        });

        group.MapPost("/saves/rename", (SaveRenameRequestDto req, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var savesDir = GetCategoryDir(gameDir, version, isolated, "saves");
            var saves = content.CreateSaves(version, isolated);
            saves.RenameSave(Path.Combine(savesDir, req.OldName), req.NewName);
            return Results.Ok();
        });

        group.MapPost("/saves/backup", (string name, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var savesDir = GetCategoryDir(gameDir, version, isolated, "saves");
            var saves = content.CreateSaves(version, isolated);
            saves.BackupSave(Path.Combine(savesDir, name));
            return Results.Ok();
        });

        group.MapDelete("/saves", (string name, string id, InstanceService instances) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var savesDir = GetCategoryDir(gameDir, version, isolated, "saves");
            var path = Path.Combine(savesDir, name);
            if (Directory.Exists(path)) Directory.Delete(path, true);
            return Results.Ok();
        });
    }

    // ──────── Servers ────────

    private static void MapServerEndpoints(RouteGroupBuilder group)
    {
        group.MapGet("/servers", (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var sm = content.CreateServerManager(gameDir, version, isolated);
            var list = sm.LoadServerList();
            var result = list.Select(s => new OldServerEntryDto
            {
                Name = s.Name,
                Ip = s.Address,
                IconBase64 = s.IconBase64,
                AcceptTextures = s.AcceptTextures
            }).ToList();
            return Results.Json(result, ApiJsonContext.Default.ListOldServerEntryDto);
        });

        group.MapPost("/servers", (AddServerRequest req, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var sm = content.CreateServerManager(gameDir, version, isolated);
            sm.AddOrUpdateServer(new ServerEntry { Name = req.Name, Address = req.Ip, AcceptTextures = true });
            return Results.Ok();
        });

        group.MapDelete("/servers", (string id, string ip, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var sm = content.CreateServerManager(gameDir, version, isolated);
            sm.RemoveServer(ip);
            return Results.Ok();
        });

        group.MapGet("/server-ping", async (string address, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var sm = content.CreateServerManager(gameDir, version, isolated);
            try
            {
                var state = sm.GetServerStateByAddress(address);
                if (state is null) return Results.Json(new ServerStateResultDto { Address = address, IsOnline = false }, ApiJsonContext.Default.ServerStateResultDto);
                var result = new ServerStateResultDto
                {
                    Name = state.Name,
                    Address = state.Address,
                    IsOnline = state.IsOnline,
                    Ping = state.Ping,
                    OnlinePlayers = state.OnlinePlayers,
                    MaxPlayers = state.MaxPlayers,
                    Version = state.Version,
                    Description = state.Description,
                    ErrorMessage = state.ErrorMessage,
                    IconBase64 = state.IconBase64
                };
                return Results.Json(result, ApiJsonContext.Default.ServerStateResultDto);
            }
            catch (OperationCanceledException)
            {
                return Results.Ok(new ServerStateResultDto
                {
                    Address = address,
                    IsOnline = false,
                    ErrorMessage = "连接超时"
                });
            }
        });

        group.MapGet("/lan-games", (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var sm = content.CreateServerManager(gameDir, version, isolated);
            var servers = sm.DiscoverLanServers(TimeSpan.FromSeconds(5));
            return Results.Json(servers, ApiJsonContext.Default.ListLanServerEntry);
        });
    }

    // ──────── Options ────────

    private static void MapOptionsEndpoints(RouteGroupBuilder group)
    {
        group.MapGet("/options", async (string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var options = await content.CreateOptionsAsync(gameDir, version, isolated);
            var list = options.GetOptionViewItems("zh-CN");
            return Results.Json(list, ApiJsonContext.Default.ListOptionViewItem);
        });

        group.MapGet("/options/{name}", async (string name, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var options = await content.CreateOptionsAsync(gameDir, version, isolated);
            var opt = options.GetDefinition(name);
            return opt is not null
                ? Results.Json(opt, ApiJsonContext.Default.OptionDefinition)
                : Results.NotFound();
        });

        group.MapPut("/options/{name}", async (string name, SetOptionRequest req, string id, InstanceService instances, ContentService content) =>
        {
            var (gameDir, version, isolated) = Resolve(id, instances);
            var options = await content.CreateOptionsAsync(gameDir, version, isolated);
            options.SetOption(name, req.Value);
            return Results.Json(new MessageResponse("ok"), ApiJsonContext.Default.MessageResponse);
        });
    }

    private static void CopyDirectory(string sourceDir, string destDir)
    {
        Directory.CreateDirectory(destDir);
        foreach (var file in Directory.GetFiles(sourceDir))
        {
            var dest = Path.Combine(destDir, Path.GetFileName(file));
            File.Copy(file, dest, true);
        }
        foreach (var dir in Directory.GetDirectories(sourceDir))
        {
            var dest = Path.Combine(destDir, Path.GetFileName(dir));
            CopyDirectory(dir, dest);
        }
    }
}
