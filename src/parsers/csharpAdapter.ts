import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { CallEdge, FunctionNode, ILanguageAdapter, TypeRelation } from './languageAdapter';

interface Pending {
    resolve: (data: any) => void;
    reject: (err: Error) => void;
    timer?: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Talks to the long-running Roslyn daemon (analyzer-csharp) over newline-delimited JSON on stdin/stdout.
 * The daemon is started once and keeps the MSBuild workspace in memory; it is restarted lazily if it dies.
 */
export class CSharpDaemonAdapter implements ILanguageAdapter {
    readonly languageId = 'csharp';
    readonly supportedExtensions = ['.cs'];

    private proc?: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<string, Pending>();
    private reqCounter = 0;
    private initPromise?: Promise<void>;
    private workspaceRoot?: string;

    constructor(
        private readonly daemonDllPath: string,
        private readonly output: vscode.OutputChannel
    ) {}

    initWorkspace(workspaceRoot: string): Promise<void> {
        this.workspaceRoot = workspaceRoot;
        const promise = Promise.resolve(vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: '$(sync~spin) Code Flow: loading C# workspace' },
            () => this.doInit(workspaceRoot)
        ));
        this.initPromise = promise;
        // Do not leave a rejected promise cached: the next call retries.
        promise.catch(err => {
            if (this.initPromise === promise) this.initPromise = undefined;
            this.output.appendLine(`[csharp] init failed: ${err.message}`);
            vscode.window.showErrorMessage(`Code Flow: could not load C# workspace — ${err.message}`);
        });
        return promise;
    }

    async listFunctions(filePath: string): Promise<FunctionNode[]> {
        await this.ready();
        return this.send<FunctionNode[]>('list_functions', { filePath });
    }

    async getOutgoingCalls(functionId: string): Promise<CallEdge[]> {
        await this.ready();
        return this.send<CallEdge[]>('get_calls', { symbolId: functionId });
    }

    async listTypes(filePath: string): Promise<FunctionNode[]> {
        await this.ready();
        return this.send<FunctionNode[]>('list_types', { filePath });
    }

    async getTypeRelations(typeId: string): Promise<TypeRelation[]> {
        await this.ready();
        return this.send<TypeRelation[]>('get_type_relations', { typeId });
    }

    async updateFile(filePath: string, text: string): Promise<void> {
        if (!this.initPromise) return;
        await this.ready();
        await this.send('update_file', { filePath, text });
    }

    dispose(): void {
        this.proc?.kill();
        this.proc = undefined;
    }

    private async ready(): Promise<void> {
        if (!this.initPromise) {
            if (!this.workspaceRoot) throw new Error('No workspace folder is open.');
            return this.initWorkspace(this.workspaceRoot);
        }
        return this.initPromise;
    }

    private async doInit(workspaceRoot: string): Promise<void> {
        const paths = await this.findProjectFiles(workspaceRoot);
        if (paths.length === 0) throw new Error('no .sln, .slnx or .csproj found in the workspace');

        const ignorePatterns = vscode.workspace.getConfiguration('codeFlow').get<string[]>('ignorePatterns', []);
        this.output.appendLine(`[csharp] loading: ${paths.join(', ')}`);
        const started = Date.now();
        const info = await this.send<{ projects: number; documents: number }>(
            'init', { paths, ignorePatterns }, 0);
        this.output.appendLine(
            `[csharp] loaded ${info.projects} project(s), ${info.documents} document(s) in ${Date.now() - started} ms`);
    }

    private async findProjectFiles(workspaceRoot: string): Promise<string[]> {
        const configured = vscode.workspace.getConfiguration('codeFlow').get<string>('csharp.solutionPath', '').trim();
        if (configured) {
            return [path.isAbsolute(configured) ? configured : path.join(workspaceRoot, configured)];
        }

        const exclude = '**/{node_modules,bin,obj,.git,.vs}/**';
        const depth = (u: vscode.Uri) => u.fsPath.split(/[\\/]/).length;

        const solutions = await vscode.workspace.findFiles('**/*.{sln,slnx}', exclude, 50);
        if (solutions.length) {
            solutions.sort((a, b) => depth(a) - depth(b));
            if (solutions.length > 1) {
                this.output.appendLine(`[csharp] several solutions found, using the top-most one. ` +
                    `Set "codeFlow.csharp.solutionPath" to pick another.`);
            }
            return [solutions[0].fsPath];
        }

        const projects = await vscode.workspace.findFiles('**/*.csproj', exclude, 200);
        return projects.map(p => p.fsPath);
    }

    private ensureProcess(): ChildProcessWithoutNullStreams {
        if (this.proc) return this.proc;

        if (!fs.existsSync(this.daemonDllPath)) {
            throw new Error(`analyzer not built (${this.daemonDllPath}). Run "npm run build:analyzer".`);
        }

        const dotnet = vscode.workspace.getConfiguration('codeFlow').get<string>('csharp.dotnetPath', 'dotnet');
        const proc = spawn(dotnet, [this.daemonDllPath], { stdio: 'pipe' });
        this.proc = proc;
        this.output.appendLine(`[csharp] daemon started (pid ${proc.pid})`);

        readline.createInterface({ input: proc.stdout }).on('line', line => this.onLine(line));
        readline.createInterface({ input: proc.stderr }).on('line', line => this.output.appendLine(line));

        const onGone = (reason: string) => {
            if (this.proc !== proc) return;
            this.proc = undefined;
            this.initPromise = undefined; // next request reloads the workspace in a fresh daemon
            this.output.appendLine(`[csharp] daemon stopped: ${reason}`);
            for (const [id, p] of this.pending) {
                clearTimeout(p.timer);
                p.reject(new Error(`analyzer daemon stopped (${reason})`));
                this.pending.delete(id);
            }
        };
        proc.on('exit', code => onGone(`exit code ${code}`));
        proc.on('error', err => onGone(err.message));
        return proc;
    }

    private onLine(line: string): void {
        let res: { id: string; ok: boolean; data?: unknown; error?: string };
        try {
            res = JSON.parse(line);
        } catch {
            this.output.appendLine(`[csharp] non-protocol output: ${line}`);
            return;
        }
        const p = this.pending.get(res.id);
        if (!p) return;
        this.pending.delete(res.id);
        clearTimeout(p.timer);
        if (res.ok) p.resolve(res.data);
        else p.reject(new Error(res.error ?? 'unknown analyzer error'));
    }

    private send<T>(action: string, payload: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
        const proc = this.ensureProcess();
        const id = `req_${++this.reqCounter}`;
        return new Promise<T>((resolve, reject) => {
            const entry: Pending = { resolve, reject };
            if (timeoutMs > 0) {
                entry.timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error(`analyzer timed out on "${action}"`));
                }, timeoutMs);
            }
            this.pending.set(id, entry);
            proc.stdin.write(JSON.stringify({ id, action, ...payload }) + '\n');
        });
    }
}
