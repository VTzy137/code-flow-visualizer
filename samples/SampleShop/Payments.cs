namespace SampleShop;

public interface IPaymentGateway
{
    void Pay(Order o);
}

public class StripeGateway : IPaymentGateway
{
    public void Pay(Order o)
    {
        try
        {
            Charge(o);
        }
        catch (TimeoutException)
        {
            Retry(o);
        }
    }

    private void Charge(Order o) { }
    private void Retry(Order o) => Charge(o);
}

public class CashGateway : IPaymentGateway
{
    public void Pay(Order o) { }
}

public abstract class Notifier
{
    public abstract void NotifyFailure(Order o);

    public virtual void SendInvoice(Order o)
    {
        if (o.Customer is null) return;
        Send(o.Customer.Email, "invoice");
    }

    protected void Send(string to, string body) { }
}

public class EmailNotifier : Notifier
{
    public override void NotifyFailure(Order o) => Send(o.Customer?.Email ?? "ops@shop", "failed");
}

public class Inventory
{
    public bool Reserve(string item) => item.Length > 0;
    public void Ship(string item) { }
}
