using System.Text.Json;
using Qomicex.Core.AOT.Builder;
using Qomicex.Launcher.Backend.Neo.Endpoints;
using Qomicex.Launcher.Backend.Neo.JsonContext;
using Qomicex.Launcher.Backend.Neo.Middleware;
using Qomicex.Launcher.Backend.Neo.Services;

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

var gameRoot = builder.Configuration["AppConfig:BaseDir"] ?? ".minecraft";
var appVersion = typeof(Program).Assembly.GetName().Version ?? new Version(1, 0, 0);
var curseForgeApiKey = builder.Configuration["CurseForge:ApiKey"] ?? "";
var core = new GameCoreBuilder()
    .Configure(o =>
    {
        o.LauncherName = "QML";
        o.GameRoot = gameRoot;
        o.MaxConcurrentDownloads = 8;
        o.UserAgent = $"Qomicex.Launcher/{appVersion.Major}.{appVersion.Minor}.{appVersion.Build}";
        o.CacheExpiry = TimeSpan.FromMinutes(30);
    })
    .UseDownloadMirror(DownloadMirror.Official)
    .WithHttpClient(new HttpClient { Timeout = TimeSpan.FromSeconds(30) })
    .Build();

builder.Services.AddHttpClient();
builder.Services.AddSingleton(core);
builder.Services.AddSingleton<InstanceService>();
builder.Services.AddSingleton<LaunchTracker>();
builder.Services.AddSingleton(sp =>
{
    var javaStore = sp.GetRequiredService<JavaRuntimeStore>();
    return new InstallTracker(javaStore);
});
builder.Services.AddSingleton<CurseForgeVersionFetchService>();
builder.Services.AddSingleton<JavaRuntimeStore>();
builder.Services.AddSingleton(sp =>
{
    var clientFactory = sp.GetRequiredService<IHttpClientFactory>();
    var store = sp.GetRequiredService<JavaRuntimeStore>();
    return new JavaDownloadService(core, clientFactory.CreateClient("default"), store);
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

app.MapAuthEndpoints(core);
app.MapVersionEndpoints(core);
app.MapLaunchEndpoints(core);
app.MapResourceEndpoints(core);
app.MapInstanceEndpoints();
app.MapSystemEndpoints();
app.MapResourceCenterEndpoints(core, curseForgeApiKey);
app.MapAccountEndpoints();
app.MapJavaEndpoints();
app.MapLoaderEndpoints();
app.MapProgressSseEndpoints();
app.MapLogEndpoints();

app.Run();
