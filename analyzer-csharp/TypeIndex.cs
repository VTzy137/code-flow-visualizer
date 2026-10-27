using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace RoslynDaemon;

/// <summary>A relation between two types (or a DI setup file and a type) for the class-flow view.</summary>
/// <param name="Kind">inherits | implements | injects | creates | registers | binds</param>
/// <param name="Follow">True when automatic depth expansion should continue to the other end
/// (the "where does this lead" direction: dependencies, base types, implementations, created objects).</param>
public record TypeRelation(
    FunctionNode Source,
    FunctionNode Target,
    string Kind,
    string Label,
    string FilePath,
    int Line,
    bool Follow);

/// <summary>
/// Solution-wide facts about types: inheritance, constructor injection, object creation and DI registrations.
/// Facts are extracted per document and cached by document version, so after an edit only that file is re-read.
/// Everything is stored as documentation-comment ids (strings), never symbols, so the cache survives recompiles.
/// </summary>
public sealed class TypeIndex
{
    private sealed record TypeFacts(
        string Id,
        List<(string Id, int Line)> Bases,
        List<(string Id, int Line)> Interfaces,
        List<(string DepId, string Param, int Line)> Deps,
        string FilePath);

    private sealed record Creation(string CreatorId, string Member, string CreatedId, string FilePath, int Line);

    private sealed record Registration(
        string? ServiceId, string? ImplId, string Lifetime, string Text, string FilePath, int Line);

    private sealed record DocFacts(
        List<TypeFacts> Types,
        List<Creation> Creations,
        List<Registration> Registrations,
        Dictionary<string, FunctionNode> Nodes);

    private readonly Dictionary<DocumentId, (VersionStamp Version, DocFacts Facts)> _cache = new();
    private readonly Func<ITypeSymbol, Solution, bool> _isUserType;

    public TypeIndex(Func<ITypeSymbol, Solution, bool> isUserType) => _isUserType = isUserType;

    public void Clear() => _cache.Clear();

    public const string DiPrefix = "di:";

    public static string DiNodeId(string filePath) => DiPrefix + Path.GetFullPath(filePath);

    // ---------------------------------------------------------------- queries

    public async Task<List<FunctionNode>> ListTypesAsync(Solution solution, Document doc)
    {
        var facts = await GetDocFactsAsync(solution, doc);
        var types = facts.Types
            .Select(t => facts.Nodes.GetValueOrDefault(t.Id))
            .Where(n => n != null)
            .Cast<FunctionNode>()
            .GroupBy(n => n.Id).Select(g => g.First())
            .OrderBy(n => n.Line)
            .ToList();

        // A file that configures DI (Program.cs, Startup.cs, ServiceCollection extensions) gets an entry point.
        if (facts.Registrations.Count > 0 && doc.FilePath != null)
            types.Insert(0, DiNode(doc.FilePath, facts.Registrations));
        return types;
    }

    public async Task<List<TypeRelation>> GetRelationsAsync(Solution solution, string typeId)
    {
        var all = await GetAllAsync(solution);
        var rels = new List<TypeRelation>();

        void Add(string src, string tgt, string kind, string label, string file, int line, bool follow)
        {
            var s = all.Node(src);
            var t = all.Node(tgt);
            if (s == null || t == null || src == tgt && kind != "creates") return;
            rels.Add(new TypeRelation(s, t, kind, label, file, line, follow));
        }

        if (typeId.StartsWith(DiPrefix))
        {
            var file = typeId[DiPrefix.Length..];
            foreach (var r in all.Registrations.Where(r => SamePath(r.FilePath, file)))
            {
                var target = r.ImplId ?? r.ServiceId!;
                Add(typeId, target, "registers", RegistrationLabel(r), r.FilePath, r.Line, true);
            }
            return Dedupe(rels);
        }

        var self = all.Types.Where(t => t.Id == typeId).ToList();
        bool isInterface = all.Node(typeId)?.Kind == "interface";

        // Upward: base class and implemented interfaces.
        foreach (var t in self)
        {
            foreach (var b in t.Bases) Add(typeId, b.Id, "inherits", "", t.FilePath, b.Line, true);
            foreach (var i in t.Interfaces) Add(typeId, i.Id, "implements", "", t.FilePath, i.Line, false);
            foreach (var d in t.Deps) Add(typeId, d.DepId, "injects", d.Param, t.FilePath, d.Line, true);
        }

        // Downward: subclasses / implementations, and who injects this type.
        foreach (var t in all.Types)
        {
            foreach (var b in t.Bases.Where(b => b.Id == typeId))
                Add(t.Id, typeId, "inherits", "", t.FilePath, b.Line, false);
            foreach (var i in t.Interfaces.Where(i => i.Id == typeId))
                Add(t.Id, typeId, "implements", "", t.FilePath, i.Line, isInterface);
            foreach (var d in t.Deps.Where(d => d.DepId == typeId))
                Add(t.Id, typeId, "injects", d.Param, t.FilePath, d.Line, false);
        }

        // DI: where this type is registered, and interface -> implementation bindings.
        foreach (var r in all.Registrations.Where(r => r.ImplId == typeId || r.ServiceId == typeId))
        {
            var target = r.ImplId ?? r.ServiceId!;
            Add(DiNodeId(r.FilePath), target, "registers", RegistrationLabel(r), r.FilePath, r.Line, false);
            if (r.ServiceId != null && r.ImplId != null && r.ServiceId != r.ImplId)
                Add(r.ServiceId, r.ImplId, "binds", $"DI {r.Lifetime}", r.FilePath, r.Line, r.ServiceId == typeId);
        }

        // Object creation: what this type news up, and where it is newed up.
        foreach (var c in all.Creations)
        {
            if (c.CreatorId == typeId) Add(typeId, c.CreatedId, "creates", $"new in {c.Member}", c.FilePath, c.Line, true);
            else if (c.CreatedId == typeId) Add(c.CreatorId, typeId, "creates", $"new in {c.Member}", c.FilePath, c.Line, false);
        }

        return Dedupe(rels);
    }

    private static List<TypeRelation> Dedupe(List<TypeRelation> rels) =>
        rels.GroupBy(r => (r.Source.Id, r.Target.Id, r.Kind, r.Label)).Select(g => g.First()).ToList();

    private static string RegistrationLabel(Registration r)
    {
        var asService = r.ServiceId != null && r.ImplId != null && r.ServiceId != r.ImplId
            ? $" as {ShortName(r.ServiceId)}" : "";
        return r.Lifetime + asService;
    }

    private static string ShortName(string docId)
    {
        var name = docId.Split(':').Last().Split('.').Last();
        var tick = name.IndexOf('`');
        return tick < 0 ? name : name[..tick];
    }

    private static bool SamePath(string a, string b) =>
        string.Equals(Path.GetFullPath(a), Path.GetFullPath(b),
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    // ---------------------------------------------------------------- aggregation

    private sealed class Aggregate
    {
        public List<TypeFacts> Types { get; } = new();
        public List<Creation> Creations { get; } = new();
        public List<Registration> Registrations { get; } = new();
        public Dictionary<string, FunctionNode> Nodes { get; } = new();

        public FunctionNode? Node(string id)
        {
            if (Nodes.TryGetValue(id, out var n)) return n;
            if (!id.StartsWith(DiPrefix)) return null;
            var file = id[DiPrefix.Length..];
            var regs = Registrations.Where(r => SamePath(r.FilePath, file)).ToList();
            return regs.Count == 0 ? null : Nodes[id] = DiNode(file, regs);
        }
    }

    private async Task<Aggregate> GetAllAsync(Solution solution)
    {
        var agg = new Aggregate();
        var live = new HashSet<DocumentId>();
        foreach (var doc in solution.Projects.SelectMany(p => p.Documents))
        {
            live.Add(doc.Id);
            var f = await GetDocFactsAsync(solution, doc);
            agg.Types.AddRange(f.Types);
            agg.Creations.AddRange(f.Creations);
            agg.Registrations.AddRange(f.Registrations);
            foreach (var (id, node) in f.Nodes) agg.Nodes.TryAdd(id, node);
        }
        foreach (var stale in _cache.Keys.Where(k => !live.Contains(k)).ToList()) _cache.Remove(stale);
        return agg;
    }

    private async Task<DocFacts> GetDocFactsAsync(Solution solution, Document doc)
    {
        var version = await doc.GetTextVersionAsync();
        if (_cache.TryGetValue(doc.Id, out var hit) && hit.Version == version) return hit.Facts;
        var facts = await ExtractAsync(solution, doc);
        _cache[doc.Id] = (version, facts);
        return facts;
    }

    // ---------------------------------------------------------------- extraction

    private async Task<DocFacts> ExtractAsync(Solution solution, Document doc)
    {
        var facts = new DocFacts(new(), new(), new(), new());
        var root = await doc.GetSyntaxRootAsync();
        var model = await doc.GetSemanticModelAsync();
        if (root == null || model == null || doc.FilePath == null) return facts;
        var file = doc.FilePath;

        bool IsUser(ITypeSymbol? t) => t != null && _isUserType(t, solution);
        string? Id(ITypeSymbol? t) => t?.OriginalDefinition.GetDocumentationCommentId();
        int LineOf(SyntaxNode n) => n.GetLocation().GetLineSpan().StartLinePosition.Line + 1;

        void Remember(INamedTypeSymbol t)
        {
            var node = ToTypeNode(t);
            if (node != null) facts.Nodes.TryAdd(node.Id, node);
        }

        // Unwraps IEnumerable<IFoo>, Lazy<Foo>, IOptions<Foo>, Func<Foo>, IFoo[] to the user type inside.
        ITypeSymbol? Unwrap(ITypeSymbol t)
        {
            if (IsUser(t)) return t;
            if (t is IArrayTypeSymbol arr) return IsUser(arr.ElementType) ? arr.ElementType : null;
            if (t is INamedTypeSymbol { IsGenericType: true } g)
                return g.TypeArguments.LastOrDefault(IsUser);
            return null;
        }

        foreach (var decl in root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>())
        {
            if (model.GetDeclaredSymbol(decl) is not INamedTypeSymbol type) continue;
            var id = Id(type);
            if (id == null) continue;
            Remember(type);

            var tf = new TypeFacts(id, new(), new(), new(), file);
            foreach (var bt in decl.BaseList?.Types ?? default)
            {
                if (model.GetTypeInfo(bt.Type).Type is not INamedTypeSymbol baseType || !IsUser(baseType)) continue;
                Remember(baseType.OriginalDefinition);
                var entry = (Id(baseType)!, LineOf(bt));
                if (baseType.TypeKind == TypeKind.Interface) tf.Interfaces.Add(entry);
                else tf.Bases.Add(entry);
            }

            if (decl is TypeDeclarationSyntax td)
            {
                var parameterLists = td.Members.OfType<ConstructorDeclarationSyntax>()
                    .Where(c => !c.Modifiers.Any(m => m.Text == "static"))
                    .Select(c => c.ParameterList)
                    .ToList();
                if (td.ParameterList != null) parameterLists.Add(td.ParameterList); // primary constructor

                foreach (var p in parameterLists.SelectMany(pl => pl.Parameters))
                {
                    if (model.GetDeclaredSymbol(p) is not IParameterSymbol ps) continue;
                    var dep = Unwrap(ps.Type);
                    if (dep is not INamedTypeSymbol depType) continue;
                    Remember(depType.OriginalDefinition);
                    tf.Deps.Add((Id(depType)!, ps.Name, LineOf(p)));
                }
            }
            facts.Types.Add(tf);
        }

        foreach (var node in root.DescendantNodes())
        {
            switch (node)
            {
                case BaseObjectCreationExpressionSyntax oc:
                {
                    if (model.GetTypeInfo(oc).Type is not INamedTypeSymbol created || !IsUser(created)) break;
                    var creator = EnclosingType(model, oc);
                    if (creator == null) break;
                    Remember(created.OriginalDefinition);
                    Remember(creator);
                    facts.Creations.Add(new Creation(Id(creator)!, MemberName(oc), Id(created)!, file, LineOf(oc)));
                    break;
                }
                case InvocationExpressionSyntax inv:
                {
                    var reg = TryRegistration(model, inv, IsUser, Id);
                    if (reg == null) break;
                    foreach (var tid in new[] { reg.Value.Service, reg.Value.Impl })
                        if (tid is INamedTypeSymbol nt && IsUser(nt)) Remember(nt.OriginalDefinition);
                    facts.Registrations.Add(new Registration(
                        IsUser(reg.Value.Service) ? Id(reg.Value.Service) : null,
                        IsUser(reg.Value.Impl) ? Id(reg.Value.Impl) : null,
                        reg.Value.Lifetime, reg.Value.Text, file, LineOf(inv)));
                    break;
                }
            }
        }

        return facts;
    }

    private static (ITypeSymbol? Service, ITypeSymbol? Impl, string Lifetime, string Text)? TryRegistration(
        SemanticModel model, InvocationExpressionSyntax inv, Func<ITypeSymbol?, bool> isUser, Func<ITypeSymbol?, string?> id)
    {
        var info = model.GetSymbolInfo(inv);
        if ((info.Symbol ?? info.CandidateSymbols.FirstOrDefault()) is not IMethodSymbol m) return null;
        if (!(m.Name.StartsWith("Add") || m.Name.StartsWith("TryAdd"))) return null;

        var def = m.ReducedFrom ?? m;
        bool onServiceCollection =
            def.IsExtensionMethod && def.Parameters.FirstOrDefault()?.Type.Name == "IServiceCollection"
            || m.ContainingType?.Name is "IServiceCollection" or "ServiceCollection";
        if (!onServiceCollection) return null;

        ITypeSymbol? service = null, impl = null;
        if (m.TypeArguments.Length >= 2) (service, impl) = (m.TypeArguments[0], m.TypeArguments[1]);
        else if (m.TypeArguments.Length == 1) service = impl = m.TypeArguments[0];

        var args = inv.ArgumentList.Arguments.Select(a => a.Expression).ToList();
        var typeofs = args.OfType<TypeOfExpressionSyntax>().Select(t => model.GetTypeInfo(t.Type).Type).ToList();
        if (service == null && typeofs.Count > 0) (service, impl) = (typeofs[0], typeofs.Count > 1 ? typeofs[1] : typeofs[0]);

        // Factory lambdas (sp => new Foo(...)) and instances (AddSingleton(new Foo())) reveal the implementation.
        bool implUnknown = impl == null || impl.TypeKind == TypeKind.Interface || impl.IsAbstract;
        if (implUnknown)
        {
            foreach (var arg in args.Where(a => a is not TypeOfExpressionSyntax))
            {
                ITypeSymbol? found = arg is AnonymousFunctionExpressionSyntax lambda
                    ? lambda.DescendantNodes().OfType<BaseObjectCreationExpressionSyntax>()
                        .Select(oc => model.GetTypeInfo(oc).Type).FirstOrDefault(isUser)
                    : model.GetTypeInfo(arg).Type is { } t && isUser(t) && t.TypeKind == TypeKind.Class ? t : null;
                if (found == null) continue;
                impl = found;
                service ??= found;
                break;
            }
        }
        impl ??= service;
        if (!isUser(service) && !isUser(impl)) return null;

        string lifetime = m.Name switch
        {
            var n when n.Contains("Singleton") => "Singleton",
            var n when n.Contains("Scoped") => "Scoped",
            var n when n.Contains("Transient") => "Transient",
            var n when n.Contains("HostedService") => "Hosted service",
            var n when n.Contains("DbContext") => "DbContext",
            var n when n.Contains("HttpClient") => "HttpClient",
            var n => n
        };

        var text = inv.Expression is MemberAccessExpressionSyntax ma ? ma.Name.ToString() : inv.Expression.ToString();
        return (service, impl, lifetime, Collapse(text));
    }

    private static INamedTypeSymbol? EnclosingType(SemanticModel model, SyntaxNode node)
    {
        var decl = node.Ancestors().OfType<BaseTypeDeclarationSyntax>().FirstOrDefault();
        if (decl != null) return model.GetDeclaredSymbol(decl) as INamedTypeSymbol;
        // Top-level statements live in the compiler-generated Program class.
        return model.GetEnclosingSymbol(node.SpanStart)?.ContainingType;
    }

    private static string MemberName(SyntaxNode node)
    {
        var member = node.Ancestors().FirstOrDefault(a =>
            a is MemberDeclarationSyntax or LocalFunctionStatementSyntax or GlobalStatementSyntax);
        return member switch
        {
            MethodDeclarationSyntax m => $"{m.Identifier.Text}()",
            ConstructorDeclarationSyntax => "constructor",
            PropertyDeclarationSyntax p => p.Identifier.Text,
            FieldDeclarationSyntax f => string.Join(", ", f.Declaration.Variables.Select(v => v.Identifier.Text)),
            LocalFunctionStatementSyntax l => $"{l.Identifier.Text}()",
            GlobalStatementSyntax => "top-level code",
            _ => "initializer"
        };
    }

    // ---------------------------------------------------------------- nodes

    private static FunctionNode DiNode(string filePath, List<Registration> regs) => new(
        DiNodeId(filePath),
        $"DI · {Path.GetFileName(filePath)}",
        $"{regs.Count} service registration(s) in {Path.GetFileName(filePath)}",
        "",
        "di",
        filePath,
        regs.Min(r => r.Line),
        regs.Max(r => r.Line));

    public static FunctionNode? ToTypeNode(INamedTypeSymbol type)
    {
        type = type.OriginalDefinition;
        var id = type.GetDocumentationCommentId();
        var syntaxRef = type.DeclaringSyntaxReferences.FirstOrDefault();
        if (id == null || syntaxRef == null) return null;

        var span = syntaxRef.SyntaxTree.GetLineSpan(syntaxRef.Span);
        var name = DisplayName(type);
        var kind = Classify(type);

        string signature;
        if (syntaxRef.GetSyntax() is BaseTypeDeclarationSyntax decl)
        {
            var attrs = string.Join(" ", decl.AttributeLists.Select(a => a.ToString()));
            var keyword = decl switch
            {
                RecordDeclarationSyntax => "record",
                ClassDeclarationSyntax => "class",
                InterfaceDeclarationSyntax => "interface",
                StructDeclarationSyntax => "struct",
                EnumDeclarationSyntax => "enum",
                _ => "type"
            };
            var bases = decl.BaseList == null ? "" : " " + decl.BaseList.ToString().Trim();
            signature = Collapse($"{attrs} {keyword} {name}{bases}".Trim());
        }
        else
        {
            // Compiler-generated Program class of top-level statements.
            signature = "top-level program";
            kind = "program";
        }

        return new FunctionNode(
            id, name, signature,
            type.ContainingNamespace is { IsGlobalNamespace: false } ns ? ns.ToDisplayString() : "",
            kind,
            syntaxRef.SyntaxTree.FilePath,
            span.StartLinePosition.Line + 1,
            span.EndLinePosition.Line + 1);
    }

    private static string DisplayName(INamedTypeSymbol t)
    {
        var name = t.Name + (t.TypeParameters.Length > 0 ? $"<{string.Join(", ", t.TypeParameters.Select(p => p.Name))}>" : "");
        return t.ContainingType != null ? $"{DisplayName(t.ContainingType)}.{name}" : name;
    }

    /// <summary>Role of the type in an app, so controllers, background services etc. stand out in the graph.</summary>
    private static string Classify(INamedTypeSymbol t)
    {
        switch (t.TypeKind)
        {
            case TypeKind.Interface: return "interface";
            case TypeKind.Enum: return "enum";
            case TypeKind.Struct: return t.IsRecord ? "record" : "struct";
        }

        var ancestors = new List<string>();
        for (var b = t.BaseType; b != null; b = b.BaseType) ancestors.Add(b.OriginalDefinition.ToDisplayString());
        bool Has(string fullName) => ancestors.Contains(fullName);

        if (Has("Microsoft.AspNetCore.Mvc.ControllerBase") || Has("System.Web.Mvc.Controller")
            || Has("System.Web.Http.ApiController")
            || t.GetAttributes().Any(a => a.AttributeClass?.Name == "ApiControllerAttribute"))
            return "controller";
        if (Has("Microsoft.Extensions.Hosting.BackgroundService")
            || t.AllInterfaces.Any(i => i.ToDisplayString() == "Microsoft.Extensions.Hosting.IHostedService"))
            return "background service";
        if (ancestors.Any(a => a.EndsWith(".DbContext"))) return "db context";
        if (ancestors.Any(a => a.StartsWith("Microsoft.AspNetCore.SignalR.Hub"))) return "signalr hub";
        if (Has("Microsoft.AspNetCore.Mvc.RazorPages.PageModel")) return "razor page";
        if (Has("Microsoft.AspNetCore.Components.ComponentBase")) return "component";
        if (Has("System.Windows.Forms.Form")) return "form";
        if (Has("System.Windows.Forms.UserControl")) return "user control";
        if (t.IsRecord) return "record";
        if (t.IsStatic) return "static class";
        if (t.IsAbstract) return "abstract class";
        return "class";
    }

    private static string Collapse(string text) => Regex.Replace(text, @"\s+", " ");
}
