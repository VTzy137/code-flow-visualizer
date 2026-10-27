namespace SampleApi.Services;

public record MonitorItem(int Id, string Name, double Value);

public interface IMonitorService
{
    MonitorItem? Find(int id);
}

public abstract class ServiceBase
{
    protected void Trace(string message) { }
}

public class MonitorService : ServiceBase, IMonitorService
{
    private readonly MonitorRepository _repo;
    private readonly IAlertSender _alerts;

    public MonitorService(MonitorRepository repo, IAlertSender alerts)
    {
        _repo = repo;
        _alerts = alerts;
    }

    public MonitorItem? Find(int id)
    {
        var item = _repo.Get(id);
        if (item?.Value > 100) _alerts.Send($"high value on {item.Name}");
        return item;
    }
}

public class MonitorRepository
{
    private readonly Dictionary<int, MonitorItem> _items = new()
    {
        [1] = new MonitorItem(1, "cpu", 42)
    };

    public MonitorItem? Get(int id) => _items.GetValueOrDefault(id);
}

public interface IAlertSender
{
    void Send(string message);
}

public class EmailAlertSender(string address) : IAlertSender
{
    public void Send(string message) { }
}

public class MonitorWorker(MonitorRepository repo) : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken) => Task.CompletedTask;
}
