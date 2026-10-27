import * as vscode from 'vscode';
import * as path from 'path';
import { AdapterRegistry, FunctionNode } from './parsers/languageAdapter';
import { CSharpDaemonAdapter } from './parsers/csharpAdapter';
import { FunctionTreeProvider } from './views/functionTreeProvider';
import { GraphWebview } from './views/graphWebview';

/** Returned from activate() so integration tests (or other extensions) can drive the analyzer. */
export interface CodeFlowApi {
    registry: AdapterRegistry;
    graph: GraphWebview;
}

export function activate(context: vscode.ExtensionContext): CodeFlowApi {
    const output = vscode.window.createOutputChannel('Code Flow');

    // ---- Language adapters: register new languages here. ----
    const registry = new AdapterRegistry();
    const daemonDll = path.join(context.extensionPath, 'dist', 'analyzer', 'RoslynDaemon.dll');
    registry.register(new CSharpDaemonAdapter(daemonDll, output));

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const initAll = () => {
        if (!workspaceRoot) return;
        for (const a of registry.all()) a.initWorkspace(workspaceRoot).catch(() => { /* reported by adapter */ });
    };
    initAll();

    const treeProvider = new FunctionTreeProvider(registry);
    const treeView = vscode.window.createTreeView('flowVisualizer.functionsSidebar', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });
    treeProvider.setView(treeView);
    const graph = new GraphWebview(context.extensionUri, registry, output);

    const activeFile = vscode.window.activeTextEditor?.document.uri;
    if (activeFile?.scheme === 'file') treeProvider.refresh(activeFile.fsPath);

    // Keep the analyzer in sync with unsaved edits (debounced per file).
    const pendingSync = new Map<string, NodeJS.Timeout>();
    const syncDocument = (doc: vscode.TextDocument) => {
        if (doc.uri.scheme !== 'file') return;
        const adapter = registry.forFile(doc.uri.fsPath);
        if (!adapter?.updateFile) return;
        const key = doc.uri.fsPath;
        clearTimeout(pendingSync.get(key));
        pendingSync.set(key, setTimeout(() => {
            pendingSync.delete(key);
            adapter.updateFile!(key, doc.getText()).catch(err =>
                output.appendLine(`[sync] ${path.basename(key)}: ${err.message}`));
        }, 400));
    };

    context.subscriptions.push(
        output,
        treeView,
        treeProvider,
        graph,
        { dispose: () => registry.dispose() },

        vscode.workspace.onDidChangeTextDocument(e => syncDocument(e.document)),

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('codeFlow.csharp') || e.affectsConfiguration('codeFlow.ignorePatterns')) {
                vscode.commands.executeCommand('flowVisualizer.reloadWorkspace');
            }
        }),

        vscode.commands.registerCommand('flowVisualizer.selectRootFunction', (fn: FunctionNode) =>
            graph.showGraphForRoot(fn)),

        vscode.commands.registerCommand('flowVisualizer.refreshSidebar', () => treeProvider.refresh()),

        vscode.commands.registerCommand('flowVisualizer.reloadWorkspace', async () => {
            initAll();
            await treeProvider.refresh();
        }),

        vscode.commands.registerCommand('flowVisualizer.selectRootClass', (type: FunctionNode) =>
            graph.showClassGraph(type)),

        vscode.commands.registerCommand('flowVisualizer.showFlowAtCursor', async () => {
            const at = cursorContext();
            if (!at) return;
            const hit = innermostAt(await at.adapter.listFunctions(at.filePath), at.filePath, at.line);
            if (hit) await graph.showGraphForRoot(hit);
            else vscode.window.showInformationMessage('Code Flow: place the cursor inside a method.');
        }),

        vscode.commands.registerCommand('flowVisualizer.showClassFlowAtCursor', async () => {
            const at = cursorContext();
            if (!at?.adapter.listTypes) return;
            const types = await at.adapter.listTypes(at.filePath);
            // Inside a type → that type; elsewhere in a DI setup file (Program.cs) → its registrations.
            const hit = innermostAt(types.filter(t => t.kind !== 'di'), at.filePath, at.line)
                ?? types.find(t => t.kind === 'di');
            if (hit) await graph.showClassGraph(hit);
            else vscode.window.showInformationMessage('Code Flow: place the cursor inside a class.');
        })
    );

    function cursorContext() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return undefined;
        const filePath = editor.document.uri.fsPath;
        const adapter = registry.forFile(filePath);
        if (!adapter) {
            vscode.window.showInformationMessage('Code Flow: this file type is not supported yet.');
            return undefined;
        }
        return { adapter, filePath, line: editor.selection.active.line + 1 };
    }

    return { registry, graph };
}

/** Innermost declaration in `filePath` that contains `line`. */
function innermostAt(nodes: FunctionNode[], filePath: string, line: number): FunctionNode | undefined {
    const same = (a: string) => path.resolve(a).toLowerCase() === path.resolve(filePath).toLowerCase();
    return nodes
        .filter(n => same(n.filePath) && n.line <= line && line <= n.endLine)
        .sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0];
}

export function deactivate(): void {
    // Disposables registered in activate() stop the daemon.
}
