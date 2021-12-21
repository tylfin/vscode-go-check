'use strict';

import vscode = require('vscode');
import { CancellationToken, CodeLens, TextDocument } from 'vscode';
import { GoDocumentSymbolProvider } from 'Go/src/goOutline';
import { getBenchmarkFunctions } from 'Go/src/testUtils';
import { getGoConfig } from 'Go/src/config';
import { getTestFunctions } from './testUtils';

export abstract class GoBaseCodeLensProvider implements vscode.CodeLensProvider {
    protected enabled: boolean = true;
    private onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();

    public get onDidChangeCodeLenses(): vscode.Event<void> {
        return this.onDidChangeCodeLensesEmitter.event;
    }

    public setEnabled(enabled: false): void {
        if (this.enabled !== enabled) {
            this.enabled = enabled;
            this.onDidChangeCodeLensesEmitter.fire();
        }
    }

    public provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.CodeLens[]> {
        return [];
    }
}

export class GoRunTestCodeLensProvider extends GoBaseCodeLensProvider {
    private readonly benchmarkRegex = /^Benchmark.+/;

    public async provideCodeLenses(document: TextDocument, token: CancellationToken): Promise<CodeLens[]> {
        if (!this.enabled) {
            return [];
        }
        const config = getGoConfig(document.uri);
        const codeLensConfig = config.get<{ [key: string]: any }>('enableCodeLens');
        const codelensEnabled = codeLensConfig ? codeLensConfig['runtest'] : false;
        if (!codelensEnabled || !document.fileName.endsWith('_test.go')) {
            return [];
        }

        const codelenses = await Promise.all([
            this.getCodeLensForPackage(document, token),
            this.getCodeLensForFunctions(document, token)
        ]);
        return ([] as CodeLens[]).concat(...codelenses);
    }

    private async getCodeLensForPackage(document: TextDocument, token: CancellationToken): Promise<CodeLens[]> {
        const documentSymbolProvider = new GoDocumentSymbolProvider();
        const symbols = await documentSymbolProvider.provideDocumentSymbols(document, token);
        if (!symbols || symbols.length === 0) {
            return [];
        }
        const pkg = symbols[0];
        if (!pkg) {
            return [];
        }
        const range = pkg.range;
        const packageCodeLens = [
            new CodeLens(range, {
                title: 'run package tests',
                command: 'go.check.test.package'
            }),
            new CodeLens(range, {
                title: 'run file tests',
                command: 'go.check.test.file'
            })
        ];
        if (
            pkg.children.some(
                (sym) => sym.kind === vscode.SymbolKind.Function && this.benchmarkRegex.test(sym.name)
            )
        ) {
            packageCodeLens.push(
                new CodeLens(range, {
                    title: 'run package benchmarks',
                    command: 'go.check.benchmark.package'
                }),
                new CodeLens(range, {
                    title: 'run file benchmarks',
                    command: 'go.check.benchmark.file'
                })
            );
        }
        return packageCodeLens;
    }

    private async getCodeLensForFunctions(document: TextDocument, token: CancellationToken): Promise<CodeLens[]> {
        const testPromise = async (): Promise<CodeLens[]> => {
            const testFunctions = await getTestFunctions(document, token);
            if (!testFunctions) {
                return [];
            }
            const codelens: CodeLens[] = [];
            for (const f of testFunctions) {
                codelens.push(new CodeLens(f.range, {
                    title: 'run test',
                    command: 'go.check.test.cursor',
                    arguments: [{ functionName: f.name }]
                }));
                codelens.push(new CodeLens(f.range, {
                    title: 'debug test',
                    command: 'go.check.debug.cursor',
                    arguments: [{ functionName: f.name }]
                }));
            }
            return codelens;
        };

        const benchmarkPromise = (async (): Promise<CodeLens[]> => {
            const benchmarkFunctions = await getBenchmarkFunctions(document, token);
            if (!benchmarkFunctions) {
                return [];
            }
            const codelens: CodeLens[] = [];
            for (const f of benchmarkFunctions) {
                codelens.push(new CodeLens(f.range, {
                    title: 'run benchmark',
                    command: 'go.check.benchmark.cursor',
                    arguments: [{ functionName: f.name }]
                }));
                codelens.push(new CodeLens(f.range, {
                    title: 'debug benchmark',
                    command: 'go.check.debug.cursor',
                    arguments: [{ functionName: f.name }]
                }));
            }
            return codelens;
        });

        const codelenses = await Promise.all([testPromise(), benchmarkPromise()]);
        return ([] as CodeLens[]).concat(...codelenses);
    }
}
