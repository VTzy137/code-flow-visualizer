using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;

namespace RoslynDaemon;

public record FunctionNode(
    string Id,
    string Name,
    string Signature,
    string ContainingType,
    string Kind,
    string FilePath,
    int Line,
    int EndLine);

public record CallEdge(
    FunctionNode Target,
    string Condition,
    IReadOnlyList<string> ConditionParts,
    IReadOnlyList<string> Context,
    bool IsInterfaceDispatch,
    string DispatchKind,
    int CallLine,
    string CallFilePath);

/// <summary>Keeps one MSBuildWorkspace in memory so every request after "init" is fast.</summary>
public sealed class WorkspaceAnalyzer
{
    private static readonly StringComparison PathComparison =
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    private MSBuildWorkspace? _workspace;
    private Solution? _solution;
    private Regex[] _ignore = [];

    /// <summary>Loads one .sln/.slnx, or any number of .csproj files into a single solution.</summary>
    public async Task<object> InitAsync(string[] paths, string[] ignorePatterns)
    {
        if (paths.Length == 0) throw new ArgumentException("No .sln/.csproj path given.");
        _ignore = ignorePatterns.Select(p => new Regex(p, RegexOptions.Compiled)).ToArray();

        _workspace?.Dispose();
        _workspace = MSBuildWorkspace.Create();
#pragma warning disable CS0618 // WorkspaceFailed is the only diagnostics hook on this Roslyn version
        _workspace.WorkspaceFailed += (_, e) =>
            Console.Error.WriteLine($"[workspace] {e.Diagnostic.Kind}: {e.Diagnostic.Message}");
#pragma warning restore CS0618

        var sln = paths.FirstOrDefault(p => p.EndsWith(".sln", StringComparison.OrdinalIgnoreCase)
                                            || p.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase));
        if (sln != null)
        {
            _solution = await _workspace.OpenSolutionAsync(sln);
        }
        else
        {
            foreach (var proj in paths)
            {
                var full = Path.GetFullPath(proj);
                // Projects already pulled in as references of an earlier project are skipped.
                if (_workspace.CurrentSolution.Projects.Any(p => string.Equals(p.FilePath, full, PathComparison)))
                    continue;
                await _workspace.OpenProjectAsync(full);
            }
            _solution = _workspace.CurrentSolution;
        }

        return new
        {
            projects = _solution.Projects.Count(),
            documents = _solution.Projects.Sum(p => p.Documents.Count())
        };
    }

    public object UpdateFile(string filePath, string text)
    {
        var solution = RequireSolution();
        var ids = solution.GetDocumentIdsWithFilePath(Path.GetFullPath(filePath));
        foreach (var id in ids)
            solution = solution.WithDocumentText(id, SourceText.From(text));
        _solution = solution;
        return new { updated = ids.Length };
    }

    public async Task<List<FunctionNode>> ListFunctionsAsync(string filePath)
    {
        var result = new List<FunctionNode>();
        var doc = FindDocument(filePath);
        if (doc == null) return result;

        var root = await doc.GetSyntaxRootAsync();
        var model = await doc.GetSemanticModelAsync();
        if (root == null || model == null) return result;

        foreach (var decl in root.DescendantNodes().OfType<BaseMethodDeclarationSyntax>())
        {
            if (model.GetDeclaredSymbol(decl) is not IMethodSymbol symbol) continue;
            var node = ToNode(symbol);
            if (node != null) result.Add(node);
        }
        return result;
    }

    public async Task<List<CallEdge>> GetOutgoingCallsAsync(string symbolId)
    {
        var solution = RequireSolution();
        var edges = new List<CallEdge>();

        var caller = await ResolveAsync(solution, symbolId);
        if (caller == null) return edges;

        foreach (var syntaxRef in caller.DeclaringSyntaxReferences)
        {
            var syntax = await syntaxRef.GetSyntaxAsync();
            var doc = solution.GetDocument(syntaxRef.SyntaxTree);
            var model = doc == null ? null : await doc.GetSemanticModelAsync();
            if (model == null) continue;

            var walker = new FlowWalker(model);
            switch (syntax)
            {
                case BaseMethodDeclarationSyntax m:
                    if (m is ConstructorDeclarationSyntax { Initializer: { } init }) walker.Visit(init);
                    walker.Visit((SyntaxNode?)m.Body ?? m.ExpressionBody);
                    break;
                default:
                    walker.Visit(syntax);
                    break;
            }

            foreach (var call in walker.Calls)
            {
                if (!IsUserCode(solution, call.Target)) continue;

                foreach (var (target, kind) in await ResolveDispatchTargetsAsync(solution, call))
                {
                    var node = ToNode(target);
                    if (node == null) continue;
                    edges.Add(new CallEdge(node, call.Condition, call.ConditionParts, call.Context, kind != "direct", kind,
                        call.Line, syntaxRef.SyntaxTree.FilePath));
                }
            }
        }

        // Same target reached under the same condition more than once collapses into one edge.
        return edges
            .GroupBy(e => (e.Target.Id, e.Condition))
            .Select(g => g.First())
            .ToList();
    }

    private async Task<List<(IMethodSymbol, string)>> ResolveDispatchTargetsAsync(Solution solution, CallSite call)
    {
        var target = call.Target;
        var result = new List<(IMethodSymbol, string)>();

        if (target.ContainingType.TypeKind == TypeKind.Interface)
        {
            var impls = await SymbolFinder.FindImplementationsAsync(target, solution);
            foreach (var impl in impls.OfType<IMethodSymbol>())
                if (IsUserCode(solution, impl)) result.Add((impl, "interface"));
            // No implementation in source: keep the interface method so the call stays visible.
            if (result.Count == 0) result.Add((target, "interface"));
            return result;
        }

        // base.Foo() is a static (non-virtual) call.
        if ((target.IsVirtual || target.IsAbstract || target.IsOverride) && !call.IsBaseCall)
        {
            if (!target.IsAbstract) result.Add((target, "direct"));
            var overrides = await SymbolFinder.FindOverridesAsync(target, solution);
            foreach (var o in overrides.OfType<IMethodSymbol>())
                if (IsUserCode(solution, o)) result.Add((o, "virtual"));
            if (result.Count == 0) result.Add((target, "virtual"));
            return result;
        }

        result.Add((target, "direct"));
        return result;
    }

    private bool IsUserCode(Solution solution, IMethodSymbol symbol)
    {
        if (symbol.MethodKind is MethodKind.LocalFunction or MethodKind.AnonymousFunction) return false;
        var loc = symbol.Locations.FirstOrDefault(l => l.IsInSource);
        if (loc?.SourceTree == null || solution.GetDocument(loc.SourceTree) == null) return false;

        var fullName = $"{symbol.ContainingType.ToDisplayString()}.{symbol.Name}";
        return !_ignore.Any(r => r.IsMatch(fullName));
    }

    private static async Task<IMethodSymbol?> ResolveAsync(Solution solution, string symbolId)
    {
        foreach (var project in solution.Projects)
        {
            var comp = await project.GetCompilationAsync();
            if (comp == null) continue;
            if (DocumentationCommentId.GetFirstSymbolForDeclarationId(symbolId, comp) is IMethodSymbol m
                && m.Locations.Any(l => l.IsInSource))
                return m;
        }
        return null;
    }

    private static FunctionNode? ToNode(IMethodSymbol symbol)
    {
        symbol = symbol.OriginalDefinition;
        var id = symbol.GetDocumentationCommentId();
        var syntaxRef = symbol.DeclaringSyntaxReferences.FirstOrDefault();
        if (id == null || syntaxRef == null) return null;

        var span = syntaxRef.SyntaxTree.GetLineSpan(syntaxRef.Span);
        var typeName = symbol.ContainingType.Name;
        var name = symbol.MethodKind switch
        {
            MethodKind.Constructor => $"{typeName}.ctor",
            MethodKind.StaticConstructor => $"{typeName}.cctor",
            _ => $"{typeName}.{symbol.Name}"
        };

        return new FunctionNode(
            id,
            name,
            symbol.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
            symbol.ContainingType.ToDisplayString(),
            symbol.MethodKind == MethodKind.Constructor ? "constructor" : "method",
            syntaxRef.SyntaxTree.FilePath,
            span.StartLinePosition.Line + 1,
            span.EndLinePosition.Line + 1);
    }

    private Document? FindDocument(string filePath)
    {
        var solution = RequireSolution();
        var full = Path.GetFullPath(filePath);
        var id = solution.GetDocumentIdsWithFilePath(full).FirstOrDefault();
        if (id != null) return solution.GetDocument(id);

        // Fallback for drive-letter / casing differences coming from VS Code.
        return solution.Projects.SelectMany(p => p.Documents)
            .FirstOrDefault(d => string.Equals(d.FilePath, full, PathComparison));
    }

    private Solution RequireSolution() =>
        _solution ?? throw new InvalidOperationException("Workspace not initialized. Send 'init' first.");
}
