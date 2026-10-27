import * as vscode from 'vscode';
import { AdapterRegistry, FunctionNode } from '../parsers/languageAdapter';

interface Folder {
    kind: 'folder';
    folder: 'functions' | 'classes';
}

interface TypeGroup {
    kind: 'type';
    name: string;
    functions: FunctionNode[];
}

/** A function (opens the call flow) or a type (opens the class flow). */
interface Entry {
    kind: 'entry';
    mode: 'call' | 'class';
    node: FunctionNode;
}

type TreeElement = Folder | TypeGroup | Entry;

const TYPE_ICONS: Record<string, string> = {
    interface: 'symbol-interface',
    enum: 'symbol-enum',
    struct: 'symbol-struct',
    record: 'symbol-structure',
    controller: 'globe',
    'background service': 'server-process',
    'db context': 'database',
    'signalr hub': 'radio-tower',
    di: 'plug',
    form: 'window',
    'user control': 'layout'
};

/**
 * Left sidebar for the active editor's file:
 *  - Functions: methods grouped by class → click shows the call flow.
 *  - Classes: types (and DI setup) → click shows the class flow (inheritance, DI, injection, creation).
 */
export class FunctionTreeProvider implements vscode.TreeDataProvider<TreeElement>, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    private groups: TypeGroup[] = [];
    private functions: FunctionNode[] = [];
    private types: FunctionNode[] = [];
    private currentFile?: string;
    private message?: string;
    private refreshSeq = 0;
    private readonly folders: Folder[] = [
        { kind: 'folder', folder: 'functions' },
        { kind: 'folder', folder: 'classes' }
    ];
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly registry: AdapterRegistry) {
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor && editor.document.uri.scheme === 'file') this.refresh(editor.document.uri.fsPath);
            }),
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (doc.uri.fsPath === this.currentFile) this.refresh(doc.uri.fsPath);
            })
        );
    }

    /** Message shown in the view when there is nothing to list. */
    setView(view: vscode.TreeView<TreeElement>): void {
        this.onDidChangeTreeData(() => (view.message = this.message));
    }

    async refresh(filePath?: string): Promise<void> {
        const target = filePath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!target) return;
        const adapter = this.registry.forFile(target);
        if (!adapter) return; // keep showing the last supported file

        const seq = ++this.refreshSeq;
        this.currentFile = target;
        this.message = 'Analyzing…';
        this.changeEmitter.fire();

        try {
            const [fns, types] = await Promise.all([
                adapter.listFunctions(target),
                adapter.listTypes ? adapter.listTypes(target) : Promise.resolve([])
            ]);
            if (seq !== this.refreshSeq) return; // a newer refresh superseded this one
            this.functions = fns;
            this.types = types;
            this.groups = groupByType(fns);
            this.message = fns.length || types.length
                ? undefined
                : 'Nothing found in this file (is it part of a loaded project?).';
        } catch (err: any) {
            if (seq !== this.refreshSeq) return;
            this.functions = [];
            this.types = [];
            this.groups = [];
            this.message = `Error: ${err.message}`;
        }
        this.changeEmitter.fire();
    }

    getTreeItem(element: TreeElement): vscode.TreeItem {
        switch (element.kind) {
            case 'folder': {
                const isFn = element.folder === 'functions';
                const count = isFn ? this.functions.length : this.types.length;
                const item = new vscode.TreeItem(isFn ? 'Functions' : 'Classes', vscode.TreeItemCollapsibleState.Expanded);
                item.description = `${count}`;
                item.iconPath = new vscode.ThemeIcon(isFn ? 'symbol-method' : 'symbol-class');
                item.tooltip = isFn
                    ? 'Click a function to see which functions it calls and under which conditions'
                    : 'Click a class to see inheritance, DI registration, injected dependencies and where it is created';
                item.id = `folder:${element.folder}`;
                return item;
            }
            case 'type': {
                const item = new vscode.TreeItem(shortTypeName(element.name), vscode.TreeItemCollapsibleState.Expanded);
                item.iconPath = new vscode.ThemeIcon('symbol-class');
                item.tooltip = element.name;
                return item;
            }
            case 'entry':
                return element.mode === 'call' ? this.functionItem(element.node) : this.typeItem(element.node);
        }
    }

    private functionItem(fn: FunctionNode): vscode.TreeItem {
        const label = fn.kind === 'constructor'
            ? `${shortTypeName(fn.containingType)} (constructor)`
            : fn.name.split('.').pop()!;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = `${fn.signature.replace(/^[^(]*/, '')}  :${fn.line}`;
        item.tooltip = new vscode.MarkdownString(`\`${fn.signature}\`\n\nClick to show call flow`);
        item.iconPath = new vscode.ThemeIcon(fn.kind === 'constructor' ? 'symbol-constructor' : 'symbol-method');
        item.command = { command: 'flowVisualizer.selectRootFunction', title: 'Show Call Flow', arguments: [fn] };
        return item;
    }

    private typeItem(t: FunctionNode): vscode.TreeItem {
        const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.None);
        item.description = t.kind === 'di' ? 'services registered here' : `${t.kind}  :${t.line}`;
        item.tooltip = new vscode.MarkdownString(`\`${t.signature}\`\n\nClick to show class flow`);
        item.iconPath = new vscode.ThemeIcon(TYPE_ICONS[t.kind] ?? 'symbol-class');
        item.command = { command: 'flowVisualizer.selectRootClass', title: 'Show Class Flow', arguments: [t] };
        return item;
    }

    getChildren(element?: TreeElement): TreeElement[] {
        if (!element) return this.functions.length || this.types.length ? this.folders : [];
        switch (element.kind) {
            case 'folder':
                if (element.folder === 'classes') {
                    return this.types.map(node => ({ kind: 'entry', mode: 'class', node }) as Entry);
                }
                return this.groups.length === 1
                    ? this.entries(this.groups[0].functions)
                    : this.groups;
            case 'type':
                return this.entries(element.functions);
            default:
                return [];
        }
    }

    private entries(fns: FunctionNode[]): Entry[] {
        return fns.map(node => ({ kind: 'entry', mode: 'call', node }));
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.changeEmitter.dispose();
    }
}

function groupByType(fns: FunctionNode[]): TypeGroup[] {
    const map = new Map<string, TypeGroup>();
    for (const fn of fns) {
        let g = map.get(fn.containingType);
        if (!g) map.set(fn.containingType, (g = { kind: 'type', name: fn.containingType, functions: [] }));
        g.functions.push(fn);
    }
    return [...map.values()];
}

function shortTypeName(full: string): string {
    return full.split('.').pop() ?? full;
}
