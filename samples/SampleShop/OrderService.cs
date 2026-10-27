namespace SampleShop;

public enum OrderStatus { Pending, Paid, Failed, Refunded }

public class Order
{
    public string Type { get; set; } = "STD";
    public OrderStatus Status { get; set; }
    public decimal Total { get; set; }
    public List<string> Items { get; } = new();
    public Customer? Customer { get; set; }
}

public class Customer
{
    public string Email { get; set; } = "";
    public bool IsBlocked { get; set; }
}

public class OrderService
{
    private readonly IPaymentGateway _gateway;
    private readonly Notifier _notifier;
    private readonly Inventory _inventory = new();

    public OrderService(IPaymentGateway gateway, Notifier notifier)
    {
        _gateway = gateway;
        _notifier = notifier;
    }

    public void Checkout(Order o)
    {
        if (o == null) return;
        if (o.Customer?.IsBlocked == true) throw new InvalidOperationException("blocked");

        Validate(o);

        if (o.Type == "VIP")
        {
            if (o.Total > 1000)
                ApplyVipDiscount(o);
            _gateway.Pay(o);
        }
        else if (o.Type == "B2B")
        {
            InvoiceLater(o);
        }
        else
        {
            _gateway.Pay(o);
        }

        HandleStatus(o);
    }

    public void HandleStatus(Order o)
    {
        switch (o.Status)
        {
            case OrderStatus.Paid:
                Dispatch(o);
                break;
            case OrderStatus.Failed:
            case OrderStatus.Refunded:
                _notifier.NotifyFailure(o);
                break;
            default:
                Console.WriteLine("pending");
                break;
        }

        var priority = o.Total > 500 ? HighPriority(o) : LowPriority(o);
        _ = priority;
    }

    private void Dispatch(Order o)
    {
        foreach (var item in o.Items)
        {
            if (!_inventory.Reserve(item)) continue;
            _inventory.Ship(item);
        }

        var label = o.Status switch
        {
            OrderStatus.Paid => Describe(o),
            _ => "n/a"
        };
        _ = label;
    }

    private void Validate(Order o)
    {
        if (o.Items.Count == 0 || o.Total <= 0)
            throw new ArgumentException("empty order");
    }

    private void ApplyVipDiscount(Order o) => o.Total *= 0.9m;
    private void InvoiceLater(Order o) => _notifier.SendInvoice(o);
    private int HighPriority(Order o) => 1;
    private int LowPriority(Order o) => 2;
    private string Describe(Order o) => $"{o.Type}:{o.Total}";
}
