using Microsoft.AspNetCore.Mvc;
using SampleApi.Services;

namespace SampleApi.Controllers;

[ApiController]
[Route("api/monitor")]
public class MonitorController : ControllerBase
{
    private readonly IMonitorService _service;
    private readonly ILogger<MonitorController> _logger;

    public MonitorController(IMonitorService service, ILogger<MonitorController> logger)
    {
        _service = service;
        _logger = logger;
    }

    [HttpGet("{id}")]
    public IActionResult Get(int id)
    {
        var item = _service.Find(id);
        if (item == null) return NotFound();
        return Ok(item);
    }
}
