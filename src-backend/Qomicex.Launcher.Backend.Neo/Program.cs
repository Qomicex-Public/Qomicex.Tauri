using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Qomicex.Core.AOT.Builder;
using Qomicex.Core.AOT.Core;
using Qomicex.Launcher.Backend.Neo.Diagnostics;
using Qomicex.Launcher.Backend.Neo.Endpoints;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Middleware;
using Qomicex.Launcher.Backend.Neo.Services;
using Qomicex.Launcher.Backend.Neo.Services.Connector;

var builder = WebApplication.CreateBuilder(args);

using (var embeddedSettings = System.Reflection.Assembly.GetExecutingAssembly()
    .GetManifestResourceStream("Qomicex.Launcher.Backend.Neo.appsettings.json"))
{
    if (embeddedSettings != null)
        builder.Configuration.AddJsonStream(embeddedSettings);
}

builder.WebHost.ConfigureKestrel(options =>
{
    options.Limits.MaxRequestBodySize = 524288000;
});

var settings = SystemEndpoints.LoadSettings();
var gameRoot = Path.GetFullPath(settings.GameDir ?? builder.Configuration["AppConfig:BaseDir"] ?? ".minecraft");
var appVersion = typeof(Program).Assembly.GetName().Version ?? new Version(1, 0, 0);
var curseForgeApiKey = builder.Configuration["CurseForge:ApiKey"] ?? "";
var microsoftClientId = builder.Configuration["Microsoft:ClientId"] ?? "";
var globalMirror = settings.DownloadSource == 1 ? DownloadMirror.BMCLAPI : DownloadMirror.Official;
var userAgent = $"Qomicex.Launcher/{appVersion.Major}.{appVersion.Minor}.{appVersion.Build}";
var core = new GameCoreBuilder()
    .Configure(o =>
    {
        o.LauncherName = "QML";
        o.GameRoot = gameRoot;
        o.MaxConcurrentDownloads = 8;
        o.UserAgent = userAgent;
        o.CacheExpiry = TimeSpan.FromMinutes(30);
    })
    .UseMicrosoftAuth(microsoftClientId)
    .UseDownloadMirror(globalMirror)
    .WithHttpClient(new HttpClient { Timeout = TimeSpan.FromSeconds(30) })
    .Build();

builder.Services.AddHttpClient("Modrinth", client =>
{
    client.DefaultRequestHeaders.UserAgent.ParseAdd("QomicexLauncher/1.0");
    client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
});
builder.Services.AddHttpClient("CurseForge", client =>
{
    client.BaseAddress = new Uri("https://api.curseforge.com");
    client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("QomicexLauncher/1.0");
});
builder.Services.AddHttpClient();
builder.Services.AddSingleton(core);

// Services
builder.Services.AddSingleton<InstanceService>();
builder.Services.AddSingleton<LaunchTracker>();
builder.Services.AddSingleton(sp =>
{
    var javaStore = sp.GetRequiredService<JavaRuntimeStore>();
    return new InstallTracker(javaStore, userAgent, curseForgeApiKey);
});
builder.Services.AddSingleton(sp =>
{
    return new ContentService(core, curseForgeApiKey);
});
builder.Services.AddSingleton(sp => new CurseForgeVersionFetchService(
    sp.GetRequiredService<IHttpClientFactory>(), curseForgeApiKey));
builder.Services.AddSingleton<JavaRuntimeStore>();
builder.Services.AddSingleton(sp =>
{
    var clientFactory = sp.GetRequiredService<IHttpClientFactory>();
    var store = sp.GetRequiredService<JavaRuntimeStore>();
    return new JavaDownloadService(core, clientFactory.CreateClient("default"), store);
});

// Diagnostics
var traceBuffer = new TraceBufferStore(2000);
builder.Services.AddSingleton(traceBuffer);
builder.Services.AddSingleton<TraceDumpService>();
Trace.Listeners.Add(new ConsoleTraceListener());
Trace.Listeners.Add(new BufferedTraceListener(traceBuffer));
Trace.AutoFlush = true;

// Account & Skin
builder.Services.AddSingleton<AccountService>();
builder.Services.AddSingleton<SkinService>();

// Connector
builder.Services.AddSingleton<LanGameListenerService>();
builder.Services.AddSingleton<GameProcessInspector>();
builder.Services.AddSingleton(sp =>
{
    var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
    var relayUserAgent = $"QML/{appVersion.Major}.{appVersion.Minor}.{appVersion.Build}";
    var apiUrl = builder.Configuration["Connector:RelayApi"] ?? "";
    var logger = sp.GetRequiredService<ILogger<PrivateRelayNodeFetcher>>();
    return new PrivateRelayNodeFetcher(client, apiUrl, relayUserAgent, logger);
});
builder.Services.AddSingleton<ConnectorService>();
builder.Services.AddSingleton<EasyTierProvider>();
builder.Services.AddSingleton(sp =>
{
    var logger = sp.GetRequiredService<ILogger<ModpackService>>();
    var core = sp.GetRequiredService<DefaultGameCore>();
    var installTracker = sp.GetRequiredService<InstallTracker>();
    var instanceService = sp.GetRequiredService<InstanceService>();
    return new ModpackService(logger, core, installTracker, instanceService, curseForgeApiKey);
});
builder.Services.AddSingleton<McmodService>();
builder.Services.AddSingleton<UpdateService>();

builder.Services.AddHttpClient("QomicexWeb", client =>
{
    client.BaseAddress = new Uri(LicenseConfig.QomicexWebBaseUrl);
    client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
    client.DefaultRequestHeaders.UserAgent.ParseAdd(userAgent);
});

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.AllowAnyOrigin()
              .AllowAnyHeader()
              .AllowAnyMethod();
    });
});

builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.TypeInfoResolverChain.Insert(0, ApiJsonContext.Default);
});

var app = builder.Build();

app.UseErrorHandling();
app.UseCors();

app.MapAuthEndpoints(core, app.Services.GetRequiredService<AccountService>());
app.MapVersionEndpoints(core);
app.MapLaunchEndpoints(core);
app.MapResourceEndpoints(core);
app.MapInstanceEndpoints();
app.MapSystemEndpoints();
app.MapResourceCenterEndpoints(core, curseForgeApiKey);
app.MapResourceDownloadEndpoints(curseForgeApiKey);
app.MapMcmodEndpoints();
app.MapAccountEndpoints(app.Services.GetRequiredService<AccountService>());
app.MapSkinEndpoints(app.Services.GetRequiredService<SkinService>());
app.MapJavaEndpoints();
app.MapLoaderEndpoints();
app.MapProgressSseEndpoints();
app.MapLogEndpoints();
app.MapConnectorEndpoints();
app.MapInstanceFilesEndpoints(curseForgeApiKey);
app.MapLicenseEndpoints();
app.MapAnnouncementEndpoints();
app.MapUpdateEndpoints();
app.MapModpackEndpoints();

// LAN listener lifecycle
var lanListener = app.Services.GetRequiredService<LanGameListenerService>();
lanListener.Start();
app.Lifetime.ApplicationStopping.Register(() => lanListener.Stop());

// Auto leave room on shutdown
var connector = app.Services.GetRequiredService<ConnectorService>();
app.Lifetime.ApplicationStopping.Register(() => { try { connector.LeaveAsync().GetAwaiter().GetResult(); } catch { } });

app.Run();
