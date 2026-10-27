import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { AdapterRegistry, FunctionNode } from '../parsers/languageAdapter';

/**
 * 'call'  — function call flow: arrows are calls, labelled with the branch condition.
 * 'class' — class flow: inheritance, DI registration, constructor injection, object creation.
 */
export type GraphMode = 'call' | 'class';

/** Edge as sent to the webview (both modes). */
interface GraphEdge {
    id: string;
    source: string;
    target: string;
    /** Style key. Call mode: direct | interface | virtual. Class mode: the relation kind. */
    edgeKind: string;
    /** Call mode: full path condition, split into &&-parts for guard hoisting. */
    condition: string;
    conditionParts: string[];
    context: string[];
    /** Class mode: fixed label text. */
    label?: string;
    /** Where the edge is written in code (call site / base list / AddScoped / new). */
    callLine: number;
    callFilePath: string;
}

type ToWebview =
    | { type: 'reset'; root: FunctionNode; direction: string; mode: GraphMode }
    | { type: 'add'; nodes: FunctionNode[]; edges: GraphEdge[]; expanded: string[] }
    | { type: 'loading'; ids: string[]; on: boolean }
    | { type: 'error'; message: string };

type FromWebview =
    | { type: 'ready' }
    | { type: 'expand'; id: string; depth?: number }
    | { type: 'jumpToNode'; id: string }
    | { type: 'jumpToCall'; edgeId: string }
    | { type: 'reroot'; id: string };

/**
 * Center panel: Cytoscape.js graph rooted at the selected function or class.
 * The extension owns graph state; the webview only renders and forwards user intents.
 */
export class GraphWebview implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private webviewReady = false;
    private queue: ToWebview[] = [];

    private mode: GraphMode = 'call';
    private nodes = new Map<string, FunctionNode>();
    private edges = new Map<string, GraphEdge>();
    /** Per node: neighbours that automatic depth expansion continues to. */
    private followers = new Map<string, Set<string>>();
    private expanded = new Set<string>();
    private inFlight = new Map<string, Promise<void>>();
    /** Bumped on every new root so results of a previous graph are dropped. */
    private generation = 0;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly registry: AdapterRegistry,
        private readonly output: vscode.OutputChannel
    ) {}

    showGraphForRoot(root: FunctionNode): Promise<void> {
        return this.show(root, 'call');
    }

    showClassGraph(root: FunctionNode): Promise<void> {
        return this.show(root, 'class');
    }

    private async show(root: FunctionNode, mode: GraphMode): Promise<void> {
        this.ensurePanel();
        this.generation++;
        this.mode = mode;
        this.nodes = new Map([[root.id, root]]);
        this.edges.clear();
        this.followers.clear();
        this.expanded.clear();
        this.inFlight.clear();

        this.panel!.title = `${mode === 'call' ? 'Flow' : 'Class'}: ${root.name}`;
        this.panel!.reveal(undefined, true);
        const config = vscode.workspace.getConfiguration('codeFlow');
        const direction = config.get<string>('layoutDirection', 'TB');
        this.post({ type: 'reset', root, direction, mode });

        const depth = mode === 'call'
            ? config.get<number>('initialDepth', 2)
            : config.get<number>('classInitialDepth', 3);
        await this.expand(root.id, depth);
    }

    /** Breadth-first expansion of `depth` levels starting at `id`. Already-expanded nodes are skipped. */
    private async expand(id: string, depth: number): Promise<void> {
        const gen = this.generation;
        let frontier = [id];

        for (let level = 0; level < depth && frontier.length; level++) {
            const todo = frontier.filter(n => !this.expanded.has(n));
            if (!todo.length) break;

            this.post({ type: 'loading', ids: todo, on: true });
            const results = await Promise.all(todo.map(n => this.expandOne(n, gen)));
            if (gen !== this.generation) return;
            this.post({ type: 'loading', ids: todo, on: false });

            frontier = [...new Set(results.flat())];
        }
    }

    /** Fetches the relations of one node, returns the neighbours depth expansion should continue to. */
    private expandOne(id: string, gen: number): Promise<string[]> {
        const existing = this.inFlight.get(id);
        if (existing) return existing.then(() => this.followersOf(id));

        const work = (async () => {
            const fn = this.nodes.get(id);
            const adapter = fn && this.registry.forFile(fn.filePath);
            if (!fn || !adapter) return;

            try {
                const fetched = this.mode === 'call'
                    ? await this.fetchCalls(adapter, id)
                    : await this.fetchRelations(adapter, id);
                if (gen !== this.generation) return;

                const newNodes: FunctionNode[] = [];
                for (const n of fetched.nodes) {
                    if (this.nodes.has(n.id)) continue;
                    this.nodes.set(n.id, n);
                    newNodes.push(n);
                }
                const newEdges = fetched.edges.filter(e => !this.edges.has(e.id));
                newEdges.forEach(e => this.edges.set(e.id, e));
                this.followers.set(id, new Set([...(this.followers.get(id) ?? []), ...fetched.follow]));
                this.expanded.add(id);
                this.post({ type: 'add', nodes: newNodes, edges: newEdges, expanded: [id] });
            } catch (err: any) {
                this.output.appendLine(`[graph] expand ${fn.name} failed: ${err.message}`);
                this.post({ type: 'error', message: `Could not expand ${fn.name}: ${err.message}` });
            }
        })();

        this.inFlight.set(id, work);
        return work
            .finally(() => { if (this.inFlight.get(id) === work) this.inFlight.delete(id); })
            .then(() => this.followersOf(id));
    }

    private async fetchCalls(adapter: NonNullable<ReturnType<AdapterRegistry['forFile']>>, id: string) {
        const calls = await adapter.getOutgoingCalls(id);
        const edges: GraphEdge[] = calls.map(c => ({
            id: `${id}->${c.target.id}@${c.callLine}:${c.condition}`,
            source: id,
            target: c.target.id,
            edgeKind: c.dispatchKind,
            condition: c.condition,
            conditionParts: c.conditionParts ?? [],
            context: c.context ?? [],
            callLine: c.callLine,
            callFilePath: c.callFilePath
        }));
        return { nodes: calls.map(c => c.target), edges, follow: calls.map(c => c.target.id) };
    }

    private async fetchRelations(adapter: NonNullable<ReturnType<AdapterRegistry['forFile']>>, id: string) {
        if (!adapter.getTypeRelations) throw new Error('class view is not supported for this language yet');
        const rels = await adapter.getTypeRelations(id);
        const edges: GraphEdge[] = rels.map(r => ({
            id: `${r.kind}:${r.source.id}->${r.target.id}:${r.label}`,
            source: r.source.id,
            target: r.target.id,
            edgeKind: r.kind,
            condition: '',
            conditionParts: [],
            context: [],
            label: r.label,
            callLine: r.line,
            callFilePath: r.filePath
        }));
        const follow = rels.filter(r => r.follow).map(r => (r.source.id === id ? r.target.id : r.source.id));
        return { nodes: rels.flatMap(r => [r.source, r.target]), edges, follow };
    }

    private followersOf(id: string): string[] {
        return [...(this.followers.get(id) ?? [])];
    }

    private async onMessage(msg: FromWebview): Promise<void> {
        switch (msg.type) {
            case 'ready':
                this.webviewReady = true;
                this.queue.forEach(m => this.panel?.webview.postMessage(m));
                this.queue = [];
                break;
            case 'expand':
                await this.expand(msg.id, msg.depth ?? 1);
                break;
            case 'jumpToNode': {
                const fn = this.nodes.get(msg.id);
                if (fn) await openAt(fn.filePath, fn.line);
                break;
            }
            case 'jumpToCall': {
                const e = this.edges.get(msg.edgeId);
                if (e) await openAt(e.callFilePath, e.callLine);
                break;
            }
            case 'reroot': {
                const fn = this.nodes.get(msg.id);
                if (fn) await this.show(fn, this.mode);
                break;
            }
        }
    }

    private post(msg: ToWebview): void {
        if (!this.panel) return;
        if (this.webviewReady) this.panel.webview.postMessage(msg);
        else this.queue.push(msg);
    }

    private ensurePanel(): void {
        if (this.panel) return;

        const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
        this.panel = vscode.window.createWebviewPanel(
            'codeFlowGraph',
            'Code Flow',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot] }
        );
        this.panel.iconPath = vscode.Uri.joinPath(mediaRoot, 'icon.svg');
        this.webviewReady = false;
        this.queue = [];
        this.panel.webview.html = this.getHtml(this.panel.webview, mediaRoot);
        this.panel.webview.onDidReceiveMessage(m => this.onMessage(m));
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.webviewReady = false;
            this.generation++;
        });
    }

    private getHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
        const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, ...p)).toString();
        const nonce = crypto.randomBytes(16).toString('base64');
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
            `img-src ${webview.cspSource} data:`,
            `font-src ${webview.cspSource}`
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${uri('graph.css')}">
  <title>Code Flow</title>
</head>
<body>
  <div id="toolbar">
    <button id="btn-fit" title="Fit graph to view">Fit</button>
    <button id="btn-dir" title="Toggle layout direction">Direction: TB</button>
    <button id="btn-expand" title="Expand the selected node one more level" disabled>Expand +1</button>
    <button id="btn-expand3" title="Expand the selected node three more levels" disabled>Expand +3</button>
    <button id="btn-reroot" title="Make the selected node the root" disabled>Set as root</button>
    <span class="spacer"></span>
    <span id="legend"></span>
  </div>
  <div id="cy"></div>
  <div id="details" hidden></div>
  <div id="status"></div>
  <div id="hint"></div>
  <script nonce="${nonce}" src="${uri('lib', 'cytoscape.min.js')}"></script>
  <script nonce="${nonce}" src="${uri('lib', 'dagre.min.js')}"></script>
  <script nonce="${nonce}" src="${uri('lib', 'cytoscape-dagre.js')}"></script>
  <script nonce="${nonce}" src="${uri('graph.js')}"></script>
</body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}

async function openAt(filePath: string, line: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(filePath);
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        selection: new vscode.Range(pos, pos)
    });
}
