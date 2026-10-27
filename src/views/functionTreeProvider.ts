import * as vscode from 'vscode';
import { AdapterRegistry, FunctionNode } from '../parsers/languageAdapter';

interface TypeGroup {
    kind: 'type';
    name: string;
    functions: FunctionNode[];
}

type TreeElement = TypeGroup | FunctionNode;

const isGroup = (e: TreeElement): e is TypeGroup => (e as TypeGroup).kind === 'type';

/** Left sidebar: functions of the active editor's file, grouped by containing type. */
export class FunctionTreeProvider implements vscode.TreeDataProvider<TreeElement>, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    private groups: TypeGroup[] = [];
    private functions: FunctionNode[] = [];
    private currentFile?: string;
    private message?: string;
    private refreshSeq = 0;
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

    get currentFunctions(): readonly FunctionNode[] {
        return this.functions;
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
            const fns = await adapter.listFunctions(target);
            if (seq !== this.refreshSeq) return; // a newer refresh superseded this one
            this.functions = fns;
            this.groups = groupByType(fns);
            this.message = fns.length ? undefined : 'No functions found in this file (is it part of a loaded project?).';
        } catch (err: any) {
            if (seq !== this.refreshSeq) return;
            this.functions = [];
            this.groups = [];
            this.message = `Error: ${err.message}`;
        }
        this.changeEmitter.fire();
    }

    getTreeItem(element: TreeElement): vscode.TreeItem {
        if (isGroup(element)) {
            const item = new vscode.TreeItem(shortTypeName(element.name), vscode.TreeItemCollapsibleState.Expanded);
            item.iconPath = new vscode.ThemeIcon('symbol-class');
            item.tooltip = element.name;
            return item;
        }

        const label = element.kind === 'constructor'
            ? `${shortTypeName(element.containingType)} (constructor)`
            : element.name.split('.').pop()!;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = `${element.signature.replace(/^[^(]*/, '')}  :${element.line}`;
        item.tooltip = new vscode.MarkdownString(`\`${element.signature}\`\n\nClick to show call flow`);
        item.iconPath = new vscode.ThemeIcon(element.kind === 'constructor' ? 'symbol-constructor' : 'symbol-method');
        item.command = {
            command: 'flowVisualizer.selectRootFunction',
            title: 'Show Call Flow',
            arguments: [element]
        };
        return item;
    }

    getChildren(element?: TreeElement): TreeElement[] {
        if (!element) return this.groups.length === 1 ? this.groups[0].functions : this.groups;
        return isGroup(element) ? element.functions : [];
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
