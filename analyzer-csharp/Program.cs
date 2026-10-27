using System.Text.Json;
using Microsoft.Build.Locator;
using RoslynDaemon;

// stdout is reserved for protocol messages. Anything else (MSBuild, Roslyn) goes to stderr.
var protocolOut = Console.Out;
Console.SetOut(Console.Error);

MSBuildLocator.RegisterDefaults();

var jsonOptions = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
var analyzer = new WorkspaceAnalyzer();

// Newline-delimited JSON loop: {"id","action",...} -> {"id","ok","data"|"error"}
string? line;
while ((line = await Console.In.ReadLineAsync()) != null)
{
    if (string.IsNullOrWhiteSpace(line)) continue;

    string id = "unknown";
    try
    {
        using var doc = JsonDocument.Parse(line);
        var req = doc.RootElement;
        id = req.GetProperty("id").GetString() ?? id;
        string action = req.GetProperty("action").GetString() ?? "";

        object? result = action switch
        {
            "init" => await analyzer.InitAsync(
                ReadStringArray(req, "paths"),
                ReadStringArray(req, "ignorePatterns")),
            "list_functions" => await analyzer.ListFunctionsAsync(req.GetProperty("filePath").GetString()!),
            "get_calls" => await analyzer.GetOutgoingCallsAsync(req.GetProperty("symbolId").GetString()!),
            "list_types" => await analyzer.ListTypesAsync(req.GetProperty("filePath").GetString()!),
            "get_type_relations" => await analyzer.GetTypeRelationsAsync(req.GetProperty("typeId").GetString()!),
            "update_file" => analyzer.UpdateFile(
                req.GetProperty("filePath").GetString()!,
                req.GetProperty("text").GetString()!),
            "ping" => "pong",
            _ => throw new InvalidOperationException($"Unknown action: {action}")
        };

        Write(new { id, ok = true, data = result });
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[daemon] request {id} failed: {ex}");
        Write(new { id, ok = false, error = ex.Message });
    }
}

void Write(object message)
{
    protocolOut.WriteLine(JsonSerializer.Serialize(message, jsonOptions));
    protocolOut.Flush();
}

static string[] ReadStringArray(JsonElement req, string name) =>
    req.TryGetProperty(name, out var arr) && arr.ValueKind == JsonValueKind.Array
        ? arr.EnumerateArray().Select(e => e.GetString() ?? "").Where(s => s.Length > 0).ToArray()
        : [];
