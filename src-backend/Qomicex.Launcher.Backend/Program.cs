using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json.Serialization;
using Qomicex.Downloader;
using Qomicex.Launcher.Backend;
using Qomicex.Launcher.Backend.Diagnostics;
using Qomicex.Launcher.Backend.Middleware;
using Qomicex.Launcher.Backend.Services;
using MsAccount = Qomicex.Core.Modules.Helpers.Account.Microsoft;

var builder = WebApplication.CreateBuilder(args);

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
builder.Services.AddSingleton<DownloadManager>();
builder.Services.AddSingleton<InstanceInstallService>();
builder.Services.AddSingleton<ResourceDownloadService>();
builder.Services.AddSingleton<JavaRuntimeStore>();
builder.Services.AddSingleton<JavaDownloadService>();
builder.Services.AddSingleton<SkinService>();
builder.Services.AddSingleton<McmodService>();
builder.Services.AddSingleton<LanGameListenerService>();
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

app.Run();
