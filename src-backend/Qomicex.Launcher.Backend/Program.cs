using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;
using Qomicex.Downloader;
using Qomicex.Launcher.Backend;
using Qomicex.Launcher.Backend.Diagnostics;
using Qomicex.Launcher.Backend.Middleware;
using Qomicex.Launcher.Backend.Services;
using MsAccount = Qomicex.Core.Modules.Helpers.Account.Microsoft;

var builder = WebApplication.CreateBuilder(args);

try
{
    var settingsPath = Path.Combine(AppPaths.BaseDir, "QML", "settings.json");
    if (File.Exists(settingsPath))
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(settingsPath));
        if (doc.RootElement.TryGetProperty("maxConnectionsPerServer", out var maxConn))
            CoreConfig.MaxConnectionsPerServer = maxConn.GetInt32();
    }
}
catch { /* use default */ }

builder.WebHost.ConfigureKestrel(options =>
{
    options.Limits.MaxRequestBodySize = 524288000; // 500 MB
});
builder.Services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = 524288500; // ~500 MB
});

builder.Services.AddSingleton(new TraceBufferStore(capacity: 2000));
builder.Services.AddSingleton<TraceDumpService>();
builder.Services.AddOpenApi();
builder.Services.AddControllers().AddJsonOptions(o => o.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.AddSingleton<IInstanceRepository, InstanceRepository>();
builder.Services.AddHttpClient("Modrinth", client =>
{
    client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("QomicexLauncher", "1.0"));
    client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
});
builder.Services.AddHttpClient("CurseForge", client =>
{
    client.BaseAddress = new Uri("https://api.curseforge.com");
    client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
    client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("QomicexLauncher", "1.0"));
});
builder.Services.AddHttpClient("FTB", client =>
{
    client.BaseAddress = new Uri("https://api.feed-the-beast.com/v1/modpacks/public");
    client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
    client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("QomicexLauncher", "1.0"));
});
builder.Services.AddHttpClient();
builder.Services.AddHttpClient("AuthlibInjector", client =>
{
    client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("QomicexLauncher", "1.0"));
    client.Timeout = TimeSpan.FromSeconds(60);
});
builder.Services.AddSingleton<LaunchService>();
builder.Services.AddSingleton<FtbService>();
builder.Services.AddSingleton<ModpackService>();
builder.Services.AddSingleton<DownloadManager>();
builder.Services.AddSingleton<InstanceInstallService>();
builder.Services.AddSingleton<ResourceDownloadService>();
builder.Services.AddSingleton<JavaRuntimeStore>();
builder.Services.AddSingleton<JavaDownloadService>();
builder.Services.AddSingleton<SkinService>();
builder.Services.AddSingleton<McmodService>();
builder.Services.AddSingleton<LanGameListenerService>();
builder.Services.AddSingleton<Qomicex.Launcher.Backend.Services.Connector.GameProcessInspector>();
builder.Services.AddSingleton<Qomicex.Launcher.Backend.Services.Connector.ConnectorService>();
builder.Services.AddSingleton(_ => new AccountService(AppPaths.BaseDir));
builder.Services.AddTransient<MsAccount>(_ => new MsAccount { ClientId = builder.Configuration["Microsoft:ClientId"] ?? string.Empty });

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.AllowAnyOrigin()
              .AllowAnyHeader()
              .AllowAnyMethod();
    });
});

var app = builder.Build();

var traceBufferStore = app.Services.GetRequiredService<TraceBufferStore>();
var traceDumpService = app.Services.GetRequiredService<TraceDumpService>();

Trace.Listeners.Add(new ConsoleTraceListener());
Trace.Listeners.Add(new BufferedTraceListener(traceBufferStore));
Trace.AutoFlush = true;

AppDomain.CurrentDomain.UnhandledException += (_, args) =>
{
    try
    {
        Trace.Flush();
        traceDumpService.Dump($"unhandled-exception: terminating={args.IsTerminating}");
    }
    catch
    {
    }
};

TaskScheduler.UnobservedTaskException += (_, args) =>
{
    try
    {
        Trace.Flush();
        traceDumpService.Dump("unobserved-task-exception");
    }
    catch
    {
    }
};

Trace.WriteLine("startup-check");
Trace.WriteLine("backend trace listeners registered");

app.UseErrorHandling();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseCors();
app.MapControllers();

var lanService = app.Services.GetRequiredService<LanGameListenerService>();
lanService.Start();
app.Lifetime.ApplicationStopping.Register(() => lanService.Stop());
var connectorService = app.Services.GetRequiredService<Qomicex.Launcher.Backend.Services.Connector.ConnectorService>();
app.Lifetime.ApplicationStopping.Register(() => { try { connectorService.LeaveAsync().GetAwaiter().GetResult(); } catch { } });

app.Run();
