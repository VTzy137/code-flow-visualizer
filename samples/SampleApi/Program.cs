using SampleApi.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddSingleton<MonitorRepository>();
builder.Services.AddScoped<IMonitorService, MonitorService>();
builder.Services.AddTransient<IAlertSender>(sp => new EmailAlertSender("ops@example.com"));
builder.Services.AddHostedService<MonitorWorker>();

var app = builder.Build();
app.MapControllers();
app.Run();
