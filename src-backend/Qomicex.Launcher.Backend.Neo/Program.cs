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
var core = new GameCoreBuilder()
    .Configure(o =>
    {
        o.LauncherName = "Qomicex";
        o.GameRoot = gameRoot;
        o.MaxConcurrentDownloads = 8;
    })
    .WithHttpClient(new HttpClient { Timeout = TimeSpan.FromSeconds(30) })
    .Build();

builder.Services.AddSingleton(core);
builder.Services.AddSingleton<InstanceService>();

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

app.Run();
