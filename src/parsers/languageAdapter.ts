/**
 * Language-agnostic contract. To support a new language (TypeScript, Python, Go...),
 * implement ILanguageAdapter and register it in extension.ts — the views never change.
 */

export interface FunctionNode {
    /** Stable id understood by the adapter that produced it (C#: documentation comment id). */
    id: string;
    /** Short display name, e.g. "OrderService.Checkout". */
    name: string;
    signature: string;
    containingType: string;
    kind: 'method' | 'constructor' | 'function';
    filePath: string;
    /** 1-based start line of the declaration. */
    line: number;
    /** 1-based end line of the declaration. */
    endLine: number;
}

export type DispatchKind = 'direct' | 'interface' | 'virtual';

export interface CallEdge {
    target: FunctionNode;
    /** Path condition under which the call runs, e.g. `o != null && o.Type == "VIP"`. Empty = unconditional. */
    condition: string;
    /** The boolean conditions of `condition`, each safe to join with " && ". */
    conditionParts: string[];
    /** Non-boolean context of the call, e.g. "foreach x in xs", "in lambda". */
    context: string[];
    /** True when the call goes through an interface/virtual member and was resolved to an implementation. */
    isInterfaceDispatch: boolean;
    dispatchKind: DispatchKind;
    /** 1-based line of the call site in the caller. */
    callLine: number;
    callFilePath: string;
}

export interface ILanguageAdapter {
    readonly languageId: string;
    readonly supportedExtensions: string[];
    initWorkspace(workspaceRoot: string): Promise<void>;
    listFunctions(filePath: string): Promise<FunctionNode[]>;
    getOutgoingCalls(functionId: string): Promise<CallEdge[]>;
    /** Push unsaved/changed file content so analysis stays current without reloading the project. */
    updateFile?(filePath: string, text: string): Promise<void>;
    dispose(): void;
}

export class AdapterRegistry {
    private readonly adapters: ILanguageAdapter[] = [];

    register(adapter: ILanguageAdapter): void {
        this.adapters.push(adapter);
    }

    forFile(filePath: string): ILanguageAdapter | undefined {
        const lower = filePath.toLowerCase();
        return this.adapters.find(a => a.supportedExtensions.some(ext => lower.endsWith(ext)));
    }

    all(): readonly ILanguageAdapter[] {
        return this.adapters;
    }

    dispose(): void {
        this.adapters.forEach(a => a.dispose());
    }
}
