using System.Net.Http.Headers;
using Qomicex.Launcher.Backend.Downloader;
using Qomicex.Launcher.Backend.Middleware;
using Qomicex.Launcher.Backend.ModRecommenderModelLib.Abstractions;
using Qomicex.Launcher.Backend.ModRecommenderModelLib.Services;
using Qomicex.Launcher.Backend.Services;
using MsAccount = Qomicex.Launcher.Backend.Modules.Helpers.Account.Microsoft;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();
builder.Services.AddControllers();
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
builder.Services.AddSingleton<FtbService>();
builder.Services.AddSingleton<DownloadManager>();
builder.Services.AddSingleton<InstanceInstallService>();
builder.Services.AddSingleton(_ => new AccountService(AppContext.BaseDirectory));
builder.Services.AddTransient<MsAccount>(_ => new MsAccount(builder.Configuration["Microsoft:ClientId"] ?? string.Empty));

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

app.UseErrorHandling();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseCors();
app.MapControllers();

app.Run();
