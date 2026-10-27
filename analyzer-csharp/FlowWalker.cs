using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace RoslynDaemon;

/// <param name="ConditionParts">Boolean conditions on the path, each safe to join with " && ".</param>
/// <param name="Context">Non-boolean context such as "foreach x in xs" or "in lambda".</param>
public record CallSite(
    IMethodSymbol Target,
    string Condition,
    IReadOnlyList<string> ConditionParts,
    IReadOnlyList<string> Context,
    int Line,
    bool IsBaseCall);

/// <summary>
/// Walks a method body and records every call together with the path condition under which it runs:
/// nested if/else, else-if chains, guard clauses (early return/throw/continue/break), switch statements
/// and expressions, ternaries, short-circuit &&/||, ?? and ?. operators, plus loop/try/lambda context.
/// </summary>
public sealed class FlowWalker : CSharpSyntaxWalker
{
    // A frame is either a boolean condition (joined with &&) or a context marker such as "foreach x in xs".
    private readonly record struct Frame(string Text, bool IsContext);

    private readonly SemanticModel _model;
    private readonly List<Frame> _frames = new();

    public List<CallSite> Calls { get; } = new();

    public FlowWalker(SemanticModel model) => _model = model;

    // ---------- Statements ----------

    public override void VisitBlock(BlockSyntax node) => VisitStatementList(node.Statements);

    public override void VisitSwitchSection(SwitchSectionSyntax node)
    {
        var sw = (SwitchStatementSyntax)node.Parent!;
        var expr = sw.Expression.ToString();
        var labels = node.Labels.Select(l => l switch
        {
            CaseSwitchLabelSyntax c => $"{expr} == {c.Value}",
            CasePatternSwitchLabelSyntax p => p.WhenClause == null
                ? $"{expr} is {p.Pattern}"
                : $"{expr} is {p.Pattern} when {p.WhenClause.Condition}",
            _ => $"{expr}: default"
        }).ToList();

        Push(labels.Count == 1 ? labels[0] : string.Join(" || ", labels.Select(Paren)));
        VisitStatementList(node.Statements);
        Pop();
    }

    public override void VisitSwitchStatement(SwitchStatementSyntax node)
    {
        Visit(node.Expression);
        foreach (var section in node.Sections) Visit(section);
    }

    public override void VisitIfStatement(IfStatementSyntax node)
    {
        Visit(node.Condition);

        Push(node.Condition.ToString());
        Visit(node.Statement);
        Pop();

        if (node.Else != null)
        {
            Push(Negate(node.Condition));
            Visit(node.Else.Statement);
            Pop();
        }
    }

    public override void VisitForEachStatement(ForEachStatementSyntax node)
    {
        Visit(node.Expression);
        PushContext($"foreach {node.Identifier.Text} in {node.Expression}");
        Visit(node.Statement);
        Pop();
    }

    public override void VisitForEachVariableStatement(ForEachVariableStatementSyntax node)
    {
        Visit(node.Expression);
        PushContext($"foreach {node.Variable} in {node.Expression}");
        Visit(node.Statement);
        Pop();
    }

    public override void VisitWhileStatement(WhileStatementSyntax node)
    {
        Visit(node.Condition);
        PushContext($"while {node.Condition}");
        Visit(node.Statement);
        Pop();
    }

    public override void VisitDoStatement(DoStatementSyntax node)
    {
        PushContext($"do-while {node.Condition}");
        Visit(node.Statement);
        Visit(node.Condition);
        Pop();
    }

    public override void VisitForStatement(ForStatementSyntax node)
    {
        if (node.Declaration != null) Visit(node.Declaration);
        foreach (var init in node.Initializers) Visit(init);
        PushContext(node.Condition == null ? "for" : $"for {node.Condition}");
        if (node.Condition != null) Visit(node.Condition);
        Visit(node.Statement);
        foreach (var inc in node.Incrementors) Visit(inc);
        Pop();
    }

    public override void VisitCatchClause(CatchClauseSyntax node)
    {
        var type = node.Declaration?.Type.ToString() ?? "Exception";
        PushContext(node.Filter == null ? $"catch {type}" : $"catch {type} when {node.Filter.FilterExpression}");
        Visit(node.Block);
        Pop();
    }

    public override void VisitFinallyClause(FinallyClauseSyntax node)
    {
        PushContext("finally");
        Visit(node.Block);
        Pop();
    }

    // Local function bodies run only when invoked; keep their calls but mark the context.
    public override void VisitLocalFunctionStatement(LocalFunctionStatementSyntax node)
    {
        PushContext($"in {node.Identifier.Text}()");
        Visit((SyntaxNode?)node.Body ?? node.ExpressionBody);
        Pop();
    }

    // ---------- Expressions ----------

    public override void VisitConditionalExpression(ConditionalExpressionSyntax node)
    {
        Visit(node.Condition);
        Push(node.Condition.ToString());
        Visit(node.WhenTrue);
        Pop();
        Push(Negate(node.Condition));
        Visit(node.WhenFalse);
        Pop();
    }

    public override void VisitBinaryExpression(BinaryExpressionSyntax node)
    {
        switch (node.Kind())
        {
            case SyntaxKind.LogicalAndExpression:
                Visit(node.Left);
                Push(node.Left.ToString());
                Visit(node.Right);
                Pop();
                break;
            case SyntaxKind.LogicalOrExpression:
                Visit(node.Left);
                Push(Negate(node.Left));
                Visit(node.Right);
                Pop();
                break;
            case SyntaxKind.CoalesceExpression:
                Visit(node.Left);
                Push($"{node.Left} == null");
                Visit(node.Right);
                Pop();
                break;
            default:
                base.VisitBinaryExpression(node);
                break;
        }
    }

    public override void VisitConditionalAccessExpression(ConditionalAccessExpressionSyntax node)
    {
        Visit(node.Expression);
        Push($"{node.Expression} != null");
        Visit(node.WhenNotNull);
        Pop();
    }

    public override void VisitSwitchExpression(SwitchExpressionSyntax node)
    {
        Visit(node.GoverningExpression);
        var expr = node.GoverningExpression.ToString();
        foreach (var arm in node.Arms)
        {
            var label = arm.Pattern is DiscardPatternSyntax ? $"{expr}: default" : $"{expr} is {arm.Pattern}";
            if (arm.WhenClause != null) label += $" when {arm.WhenClause.Condition}";
            Push(label);
            Visit(arm.Expression);
            Pop();
        }
    }

    public override void VisitSimpleLambdaExpression(SimpleLambdaExpressionSyntax node) => VisitLambda(node);
    public override void VisitParenthesizedLambdaExpression(ParenthesizedLambdaExpressionSyntax node) => VisitLambda(node);
    public override void VisitAnonymousMethodExpression(AnonymousMethodExpressionSyntax node) => VisitLambda(node);

    private void VisitLambda(AnonymousFunctionExpressionSyntax node)
    {
        PushContext("in lambda");
        Visit(node.Body);
        Pop();
    }

    public override void VisitInvocationExpression(InvocationExpressionSyntax node)
    {
        // Arguments and receiver are evaluated before the call itself.
        base.VisitInvocationExpression(node);
        var isBase = node.Expression is MemberAccessExpressionSyntax { Expression: BaseExpressionSyntax };
        Record(node, isBase);
    }

    public override void VisitObjectCreationExpression(ObjectCreationExpressionSyntax node)
    {
        base.VisitObjectCreationExpression(node);
        Record(node, false);
    }

    public override void VisitImplicitObjectCreationExpression(ImplicitObjectCreationExpressionSyntax node)
    {
        base.VisitImplicitObjectCreationExpression(node);
        Record(node, false);
    }

    // ---------- Helpers ----------

    /// <summary>Visits statements in order; a guard clause adds its negated condition to everything after it.</summary>
    private void VisitStatementList(SyntaxList<StatementSyntax> statements)
    {
        int guards = 0;
        foreach (var stmt in statements)
        {
            Visit(stmt);
            if (stmt is IfStatementSyntax { Else: null } ifs && AlwaysExits(ifs.Statement))
            {
                Push(Negate(ifs.Condition));
                guards++;
            }
        }
        for (int i = 0; i < guards; i++) Pop();
    }

    private static bool AlwaysExits(StatementSyntax stmt) => stmt switch
    {
        ReturnStatementSyntax or ThrowStatementSyntax or BreakStatementSyntax
            or ContinueStatementSyntax or GotoStatementSyntax => true,
        ExpressionStatementSyntax { Expression: ThrowExpressionSyntax } => true,
        BlockSyntax b => b.Statements.Count > 0 && AlwaysExits(b.Statements.Last()),
        IfStatementSyntax { Else: { } e } i => AlwaysExits(i.Statement) && AlwaysExits(e.Statement),
        _ => false
    };

    private void Record(ExpressionSyntax node, bool isBaseCall)
    {
        var info = _model.GetSymbolInfo(node);
        var symbol = info.Symbol ?? info.CandidateSymbols.FirstOrDefault();
        if (symbol is not IMethodSymbol method) return;

        method = method.ReducedFrom ?? method; // extension method called as instance method
        method = method.OriginalDefinition;     // generic instantiation -> declaration

        var line = node.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
        var context = _frames.Where(f => f.IsContext).Select(f => f.Text).ToList();
        var conds = _frames.Where(f => !f.IsContext).Select(f => f.Text).ToList();
        var parts = conds.Count <= 1 ? conds : conds.Select(Paren).ToList();
        Calls.Add(new CallSite(method, FormatCondition(parts, context), parts, context, line, isBaseCall));
    }

    public static string FormatCondition(IReadOnlyList<string> parts, IReadOnlyList<string> context)
    {
        var condText = string.Join(" && ", parts);
        var ctxText = context.Count == 0 ? "" : "[" + string.Join(" › ", context) + "]";
        return string.Join(" ", new[] { ctxText, condText }.Where(s => s.Length > 0));
    }

    private void Push(string condition) => _frames.Add(new Frame(condition, false));
    private void PushContext(string context) => _frames.Add(new Frame(context, true));
    private void Pop() => _frames.RemoveAt(_frames.Count - 1);

    /// <summary>Wraps compound expressions in parentheses when joining with &&.</summary>
    private static string Paren(string text)
    {
        var parsed = SyntaxFactory.ParseExpression(text);
        bool needs = parsed is BinaryExpressionSyntax b
                     && (b.IsKind(SyntaxKind.LogicalOrExpression) || b.IsKind(SyntaxKind.CoalesceExpression))
                     || parsed is ConditionalExpressionSyntax;
        return needs ? $"({text})" : text;
    }

    /// <summary>Readable negation: a == b → a != b, !x → x, a &lt; b → a &gt;= b, otherwise !(expr).</summary>
    private static string Negate(ExpressionSyntax expr)
    {
        while (expr is ParenthesizedExpressionSyntax p) expr = p.Expression;

        if (expr is PrefixUnaryExpressionSyntax u && u.IsKind(SyntaxKind.LogicalNotExpression))
        {
            var inner = u.Operand;
            while (inner is ParenthesizedExpressionSyntax ip) inner = ip.Expression;
            return inner.ToString();
        }

        if (expr is BinaryExpressionSyntax bin)
        {
            string? op = bin.Kind() switch
            {
                SyntaxKind.EqualsExpression => "!=",
                SyntaxKind.NotEqualsExpression => "==",
                SyntaxKind.LessThanExpression => ">=",
                SyntaxKind.LessThanOrEqualExpression => ">",
                SyntaxKind.GreaterThanExpression => "<=",
                SyntaxKind.GreaterThanOrEqualExpression => "<",
                _ => null
            };
            if (op != null) return $"{bin.Left} {op} {bin.Right}";
        }

        if (expr is IsPatternExpressionSyntax isp)
        {
            if (isp.Pattern is UnaryPatternSyntax { RawKind: (int)SyntaxKind.NotPattern } np)
                return $"{isp.Expression} is {np.Pattern}";
            return $"{isp.Expression} is not {isp.Pattern}";
        }

        if (expr is IdentifierNameSyntax or MemberAccessExpressionSyntax or InvocationExpressionSyntax)
            return $"!{expr}";

        return $"!({expr})";
    }
}
