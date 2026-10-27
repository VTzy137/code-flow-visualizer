# Code Flow Visualizer

A VS Code extension that draws a **conditional call graph** rooted at a function you pick:
if `A` calls `B` inside `if (x == value)`, the arrow `A → B` is labelled `x == value`.

```
public void Checkout(Order o) {
    if (o == null) return;                     OrderService.Checkout
    if (o.Type == "VIP") _gateway.Pay(o);        │ o != null && o.Type == "VIP"   (dashed: via IPaymentGateway)
    else InvoiceLater(o);                        ├──────────▶ StripeGateway.Pay
}                                                ├──────────▶ CashGateway.Pay
                                                 │ o != null && o.Type != "VIP"
                                                 └──────────▶ OrderService.InvoiceLater
```

C# (.NET) is the first supported language. The analyzer is language-pluggable (see *Adding a language*).

## What the analyzer understands (C#)

| Construct | Edge label |
| --- | --- |
| Nested `if` | `a > 0 && b == 1` |
| `else` / `else if` chains | `o.Type != "VIP" && o.Type == "B2B"` |
| Guard clauses (`if (x == null) return;` / `throw` / `continue` / `break`) | later calls get `x != null` |
| `switch` statement (incl. several labels, patterns, `when`) | `o.Status == OrderStatus.Failed \|\| o.Status == OrderStatus.Refunded` |
| `switch` expression arms | `o.Status is OrderStatus.Paid` |
| Ternary `?:`, `&&`, `\|\|`, `??`, `?.` | branch-specific conditions |
| `foreach` / `for` / `while` / `do`, `catch`, `finally`, lambdas, local functions | context prefix, e.g. `[foreach item in o.Items]` |
| Calls through an **interface** (DI) | resolved to each implementation, **dashed purple** edge |
| Calls to **virtual / abstract** members | resolved to overrides, **dotted orange** edge |
| `new Foo()` | edge to the constructor |

Only code that lives in your solution is drawn. `System.*`, `Microsoft.*` and other NuGet/framework calls are dropped
automatically; add more with `codeFlow.ignorePatterns` (e.g. your logging wrapper).

## Using it

1. Open a folder containing a `.sln`, `.slnx` or `.csproj`.
2. Click the **Code Flow** icon in the activity bar. The sidebar lists the methods of the active `.cs` file, grouped by class.
3. Click a method. The graph opens beside the editor with `codeFlow.initialDepth` levels (default 2) loaded.
4. In the graph:
   - **Right-click** a node (or select it and press **Expand +1 / +3**) to load deeper calls. Nodes that are not expanded yet have a dashed border and a `＋`.
   - **Double-click** a node to open the function.
   - **Click an edge** to jump to the exact call site and see the full condition.
   - **Set as root** re-centres the graph on the selected node. **Direction** switches between top-to-bottom and left-to-right.

You can also right-click inside a method in the editor and choose **Show Call Flow for Function at Cursor**.

Unsaved edits are pushed to the analyzer as you type, so the graph reflects the current buffer.
Use **Reload Workspace** (sidebar title bar) after adding projects or files.

## Running locally (no Marketplace needed)

Requirements: Node.js 18+, .NET SDK 8+ (the analyzer targets `net10.0` and rolls forward).

```bash
npm install
npm run build        # builds the Roslyn daemon into dist/analyzer and compiles the TypeScript
```

**Debug:** open this folder in VS Code and press **F5**. *Run Extension (sample C# project)* opens
`samples/SampleShop` in an Extension Development Host so you can try it right away.

**Install as a .vsix:**

```bash
npm run package                                        # creates code-flow-visualizer-0.1.0.vsix
code --install-extension code-flow-visualizer-0.1.0.vsix
```

The `.vsix` contains the compiled analyzer, so the target machine only needs the .NET runtime/SDK.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `codeFlow.initialDepth` | `2` | Levels loaded when a root is selected |
| `codeFlow.csharp.solutionPath` | `""` | Force a specific `.sln` / `.csproj` (otherwise the top-most `.sln`, else every `.csproj`) |
| `codeFlow.csharp.dotnetPath` | `dotnet` | dotnet executable used to start the analyzer |
| `codeFlow.ignorePatterns` | logging calls | Regexes matched against `Namespace.Type.Method` |
| `codeFlow.layoutDirection` | `TB` | `TB` or `LR` |

Analyzer logs (project load, MSBuild warnings, errors) go to the **Code Flow** output channel.

## Architecture

```
┌────────────────────── VS Code extension (TypeScript) ──────────────────────┐
│ FunctionTreeProvider ──select fn──▶ GraphWebview (Cytoscape.js + dagre)    │
│          │                                  ▲  expand / jump / reroot       │
│          ▼                                  │                               │
│   AdapterRegistry ──▶ ILanguageAdapter ─────┘                               │
│                          └─ CSharpDaemonAdapter                             │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ newline-delimited JSON over stdin/stdout
┌──────────────────────────────▼─────────────────────────────────────────────┐
│ analyzer-csharp (long-running .NET process)                                │
│   WorkspaceAnalyzer: MSBuildWorkspace kept in memory, incremental updates  │
│   FlowWalker:        path conditions (if/else/guard/switch/?:/&&/||/?.)    │
│   SymbolFinder:      interface implementations and virtual overrides       │
└────────────────────────────────────────────────────────────────────────────┘
```

The daemon is started once and keeps the workspace loaded, so after the first load each expansion takes tens to a few
hundred milliseconds. If it crashes it is restarted automatically on the next request.

Protocol (one JSON object per line):

| Request `action` | Payload | Response `data` |
| --- | --- | --- |
| `init` | `paths: string[]`, `ignorePatterns: string[]` | `{ projects, documents }` |
| `list_functions` | `filePath` | `FunctionNode[]` |
| `get_calls` | `symbolId` | `CallEdge[]` |
| `update_file` | `filePath`, `text` | `{ updated }` |

Every response is `{ "id": <request id>, "ok": true, "data": ... }` or `{ "id", "ok": false, "error" }`.

### Adding a language

1. Implement `ILanguageAdapter` (`src/parsers/languageAdapter.ts`): `listFunctions`, `getOutgoingCalls`, optionally `updateFile`.
   It can run in-process (e.g. the TypeScript compiler API, tree-sitter) or talk to a daemon like the C# one.
2. Register it in `src/extension.ts`: `registry.register(new MyAdapter(...))`.
3. Add its `onLanguage:` activation event in `package.json`.

The sidebar and the graph pick the adapter by file extension, so nothing else changes.

## Known limitations

- Static analysis: it shows every call that *can* happen and the syntactic condition guarding it. It does not evaluate values,
  so conditions that depend on earlier assignments are shown as written.
- Calls made through delegates, events, reflection or DI container registration lookups are not resolved.
- Property getters/setters are not drawn as nodes; local functions and lambdas are folded into their containing method
  (with an `[in lambda]` / `[in Foo()]` prefix).
- Guard clauses are detected when the `if` body always exits (`return`, `throw`, `break`, `continue`, `goto`).
