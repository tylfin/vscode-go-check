'use strict';

import cp = require('child_process');
import path = require('path');
import util = require('util');
import vscode = require('vscode');

import { applyCodeCoverageToAllEditors } from 'Go/src/goCover';
import { getCurrentPackage } from 'Go/src/goModules';
import { GoDocumentSymbolProvider } from 'Go/src/goOutline';
import { getNonVendorPackages } from 'Go/src/goPackages';
import { envPath, getCurrentGoWorkspaceFromGOPATH, parseEnvFile } from 'Go/src/goPath';
import {
    getBinPath,
    getCurrentGoPath,
    getGoVersion,
    getTempFilePath,
    getToolsEnvVars,
    killTree,
    LineBuffer,
    resolvePath
} from 'Go/src/util';

const outputChannel = vscode.window.createOutputChannel('Go Tests');
const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
statusBarItem.command = 'go.test.cancel';
statusBarItem.text = '$(x) Cancel Running Tests';

/**
 *  testProcesses holds a list of currently running test processes.
 */
const runningTestProcesses: cp.ChildProcess[] = [];

const testFuncRegex = /^Test.*|^Example.*/;
const testMethodRegex = /^\(([^)]+)\)\.(Test.*)$/;
const benchmarkRegex = /^Benchmark.*/;

/**
 * Input to goTest.
 */
export interface TestConfig {
	/**
	 * The working directory for `go test`.
	 */
    dir: string;
	/**
	 * Configuration for the Go extension
	 */
    goConfig: vscode.WorkspaceConfiguration;
	/**
	 * Test flags to override the testFlags and buildFlags from goConfig.
	 */
    flags: string[];
	/**
	 * Specific function names to test.
	 */
    functions?: string[];
	/**
	 * Test was not requested explicitly. The output should not appear in the UI.
	 */
    background?: boolean;
	/**
	 * Run all tests from all sub directories under `dir`
	 */
    includeSubDirectories?: boolean;
	/**
	 * Whether this is a benchmark.
	 */
    isBenchmark?: boolean;
	/**
	 * Whether the tests are being run in a project that uses Go modules
	 */
    isMod?: boolean;
	/**
	 * Whether code coverage should be generated and applied.
	 */
    applyCodeCoverage?: boolean;
}

export function getTestEnvVars(config: vscode.WorkspaceConfiguration): any {
    const envVars = getToolsEnvVars();
    const testEnvConfig = config['testEnvVars'] || {};

    let fileEnv: { [key: string]: any } = {};
    let testEnvFile = config['testEnvFile'];
    if (testEnvFile) {
        testEnvFile = resolvePath(testEnvFile);
        try {
            fileEnv = parseEnvFile(testEnvFile);
        } catch (e) {
            console.log(e);
        }
    }

    Object.keys(fileEnv).forEach(
        (key) => (envVars[key] = typeof fileEnv[key] === 'string' ? resolvePath(fileEnv[key]) : fileEnv[key])
    );
    Object.keys(testEnvConfig).forEach(
        (key) =>
            (envVars[key] =
                typeof testEnvConfig[key] === 'string' ? resolvePath(testEnvConfig[key]) : testEnvConfig[key])
    );

    return envVars;
}

export function getTestFlags(goConfig: vscode.WorkspaceConfiguration, args?: any): string[] {
    let testFlags: string[] = goConfig['testFlags'] || goConfig['buildFlags'] || [];
    testFlags = testFlags.map((x) => resolvePath(x)); // Use copy of the flags, dont pass the actual object from config
    return args && args.hasOwnProperty('flags') && Array.isArray(args['flags']) ? args['flags'] : testFlags;
}

export function getTestTags(goConfig: vscode.WorkspaceConfiguration): string {
    return goConfig['testTags'] !== null ? goConfig['testTags'] : goConfig['buildTags'];
}

/**
 * Returns all Go unit test functions in the given source file.
 *
 * @param the URI of a Go source file.
 * @return test function symbols for the source file.
 */
export function getTestFunctions(
    doc: vscode.TextDocument,
    token: vscode.CancellationToken
): Thenable<vscode.DocumentSymbol[]> {
    const documentSymbolProvider = new GoDocumentSymbolProvider(true);
    return documentSymbolProvider
        .provideDocumentSymbols(doc, token)
        .then((symbols) => symbols[0].children)
        .then((symbols) => {
            const checkv1 = symbols.some(
                (sym) => sym.kind === vscode.SymbolKind.Namespace && sym.name === '"gopkg.in/check.v1"'
            );
            return symbols.filter(
                (sym) =>
                    sym.kind === vscode.SymbolKind.Function &&
                    (testFuncRegex.test(sym.name) || (checkv1 && testMethodRegex.test(sym.name)))
            );
        });
}

/**
 * Extracts test method name of a suite test function.
 * For example a symbol with name "(*testSuite).TestMethod" will return "TestMethod".
 *
 * @param symbolName Symbol Name to extract method name from.
 */
export function extractInstanceTestName(symbolName: string): string {
    const match = symbolName.match(testMethodRegex);
    if (!match || match.length !== 3) {
        return null;
    }
    return match[2];
}

/**
 * Gets the appropriate debug arguments for a debug session on a test function.
 * @param document  The document containing the tests
 * @param testFunctionName The test function to get the debug args
 * @param testFunctions The test functions found in the document
 */
export function getTestFunctionDebugArgs(
    document: vscode.TextDocument,
    testFunctionName: string,
    testFunctions: vscode.DocumentSymbol[]
): string[] {
    if (benchmarkRegex.test(testFunctionName)) {
        return ['-test.bench', '^' + testFunctionName + '$', '-test.run', 'a^'];
    }
    const instanceMethod = extractInstanceTestName(testFunctionName);
    if (instanceMethod) {
        const testFns = findAllTestSuiteRuns(document, testFunctions);
        const testSuiteTests = ['-check.f', `^${instanceMethod}$`];
        return [...testSuiteTests];
    } else {
        return ['-test.run', `^${testFunctionName}$`];
    }
}
/**
 * Finds test methods containing "suite.Run()" call.
 *
 * @param doc Editor document
 * @param allTests All test functions
 */
export function findAllTestSuiteRuns(
    doc: vscode.TextDocument,
    allTests: vscode.DocumentSymbol[]
): vscode.DocumentSymbol[] {
    // get non-instance test functions
    const testFunctions = allTests.filter((t) => !testMethodRegex.test(t.name));
    // filter further to ones containing suite.Run()
    return testFunctions.filter((t) => doc.getText(t.range).includes('suite.Run('));
}

/**
 * Returns all Benchmark functions in the given source file.
 *
 * @param the URI of a Go source file.
 * @return benchmark function symbols for the source file.
 */
export function getBenchmarkFunctions(
    doc: vscode.TextDocument,
    token: vscode.CancellationToken
): Thenable<vscode.DocumentSymbol[]> {
    const documentSymbolProvider = new GoDocumentSymbolProvider();
    return documentSymbolProvider
        .provideDocumentSymbols(doc, token)
        .then((symbols) => symbols[0].children)
        .then((symbols) =>
            symbols.filter((sym) => sym.kind === vscode.SymbolKind.Function && benchmarkRegex.test(sym.name))
        );
}

/**
 * Runs go test and presents the output in the 'Go' channel.
 *
 * @param goConfig Configuration for the Go extension.
 */
export async function goTest(testconfig: TestConfig): Promise<boolean> {
    const tmpCoverPath = getTempFilePath('go-code-cover');
    const testResult = await new Promise<boolean>(async (resolve, reject) => {
        // We do not want to clear it if tests are already running, as that could
        // lose valuable output.
        if (runningTestProcesses.length < 1) {
            outputChannel.clear();
        }

        if (!testconfig.background) {
            outputChannel.show(true);
        }

        const testTags: string = getTestTags(testconfig.goConfig);
        const args: Array<string> = ['test'];
        const testType: string = testconfig.isBenchmark ? 'Benchmarks' : 'Tests';

        if (testconfig.isBenchmark) {
            args.push('-benchmem', '-run=^$');
        } else {
            args.push('-timeout', testconfig.goConfig['testTimeout']);
            if (testconfig.applyCodeCoverage) {
                args.push('-coverprofile=' + tmpCoverPath);
            }
        }
        if (testTags && testconfig.flags.indexOf('-tags') === -1) {
            args.push('-tags', testTags);
        }

        const testEnvVars = getTestEnvVars(testconfig.goConfig);
        const goRuntimePath = getBinPath('go');

        if (!goRuntimePath) {
            vscode.window.showErrorMessage(
                `Failed to run "go test" as the "go" binary cannot be found in either GOROOT(${process.env['GOROOT']}) or PATH(${envPath})`
            );
            return Promise.resolve();
        }

        const currentGoWorkspace = testconfig.isMod
            ? ''
            : getCurrentGoWorkspaceFromGOPATH(getCurrentGoPath(), testconfig.dir);
        let targets = targetArgs(testconfig);
        let getCurrentPackagePromise = Promise.resolve('');
        if (testconfig.isMod) {
            getCurrentPackagePromise = getCurrentPackage(testconfig.dir);
        } else if (currentGoWorkspace) {
            getCurrentPackagePromise = Promise.resolve(testconfig.dir.substr(currentGoWorkspace.length + 1));
        }
        let pkgMapPromise: Promise<Map<string, string> | null> = Promise.resolve(null);
        if (testconfig.includeSubDirectories) {
            if (testconfig.isMod) {
                targets = ['./...'];
                // We need the mapping to get absolute paths for the files in the test output
                pkgMapPromise = getNonVendorPackages(testconfig.dir);
            } else {
                pkgMapPromise = getGoVersion().then((goVersion) => {
                    if (goVersion.gt('1.8')) {
                        targets = ['./...'];
                        return null; // We dont need mapping, as we can derive the absolute paths from package path
                    }
                    return getNonVendorPackages(testconfig.dir).then((pkgMap) => {
                        targets = Array.from(pkgMap.keys());
                        return pkgMap; // We need the individual package paths to pass to `go test`
                    });
                });
            }
        }

        Promise.all([pkgMapPromise, getCurrentPackagePromise]).then(
            ([pkgMap, currentPackage]) => {
                if (!pkgMap) {
                    pkgMap = new Map<string, string>();
                }
                // Use the package name to be in the args to enable running tests in symlinked directories
                if (!testconfig.includeSubDirectories && currentPackage) {
                    targets.splice(0, 0, currentPackage);
                }

                const outTargets = args.slice(0);
                if (targets.length > 4) {
                    outTargets.push('<long arguments omitted>');
                } else {
                    outTargets.push(...targets);
                }

                args.push(...targets);

                // ensure that user provided flags are appended last (allow use of -args ...)
                // ignore user provided -run flag if we are already using it
                if (args.indexOf('-run') > -1) {
                    removeRunFlag(testconfig.flags);
                }
                args.push(...testconfig.flags);

                outTargets.push(...testconfig.flags);
                outputChannel.appendLine(['Running tool:', goRuntimePath, ...outTargets].join(' '));
                outputChannel.appendLine('');

                const tp = cp.spawn(goRuntimePath, args, { env: testEnvVars, cwd: testconfig.dir });
                const outBuf = new LineBuffer();
                const errBuf = new LineBuffer();

                // 1=ok/FAIL, 2=package, 3=time/(cached)
                const packageResultLineRE = /^(ok|FAIL)[ \t]+(.+?)[ \t]+([0-9\.]+s|\(cached\))/;
                const lineWithErrorRE = /^(\t|\s\s\s\s)\S/;
                const testResultLines: string[] = [];

                const processTestResultLine = (line: string) => {
                    testResultLines.push(line);
                    const result = line.match(packageResultLineRE);
                    if (result && (pkgMap.has(result[2]) || currentGoWorkspace)) {
                        const hasTestFailed = line.startsWith('FAIL');
                        const packageNameArr = result[2].split('/');
                        const baseDir = pkgMap.get(result[2]) || path.join(currentGoWorkspace, ...packageNameArr);
                        testResultLines.forEach((testResultLine) => {
                            if (hasTestFailed && lineWithErrorRE.test(testResultLine)) {
                                outputChannel.appendLine(expandFilePathInOutput(testResultLine, baseDir));
                            } else {
                                outputChannel.appendLine(testResultLine);
                            }
                        });
                        testResultLines.splice(0);
                    }
                };

                // go test emits test results on stdout, which contain file names relative to the package under test
                outBuf.onLine((line) => processTestResultLine(line));
                outBuf.onDone((last) => {
                    if (last) {
                        processTestResultLine(last);
                    }

                    // If there are any remaining test result lines, emit them to the output channel.
                    if (testResultLines.length > 0) {
                        testResultLines.forEach((line) => outputChannel.appendLine(line));
                    }
                });

                // go test emits build errors on stderr, which contain paths relative to the cwd
                errBuf.onLine((line) => outputChannel.appendLine(expandFilePathInOutput(line, testconfig.dir)));
                errBuf.onDone((last) => last && outputChannel.appendLine(expandFilePathInOutput(last, testconfig.dir)));

                tp.stdout.on('data', (chunk) => outBuf.append(chunk.toString()));
                tp.stderr.on('data', (chunk) => errBuf.append(chunk.toString()));

                statusBarItem.show();

                tp.on('close', (code, signal) => {
                    outBuf.done();
                    errBuf.done();

                    const index = runningTestProcesses.indexOf(tp, 0);
                    if (index > -1) {
                        runningTestProcesses.splice(index, 1);
                    }

                    if (!runningTestProcesses.length) {
                        statusBarItem.hide();
                    }

                    resolve(code === 0);
                });

                runningTestProcesses.push(tp);
            },
            (err) => {
                outputChannel.appendLine(`Error: ${testType} failed.`);
                outputChannel.appendLine(err);
                resolve(false);
            }
        );
    });
    if (testconfig.applyCodeCoverage) {
        await applyCodeCoverageToAllEditors(tmpCoverPath, testconfig.dir);
    }
    return testResult;
}

/**
 * Reveals the output channel in the UI.
 */
export function showTestOutput() {
    outputChannel.show(true);
}

/**
 * Iterates the list of currently running test processes and kills them all.
 */
export function cancelRunningTests(): Thenable<boolean> {
    return new Promise<boolean>((resolve, reject) => {
        runningTestProcesses.forEach((tp) => {
            killTree(tp.pid);
        });
        // All processes are now dead. Empty the array to prepare for the next run.
        runningTestProcesses.splice(0, runningTestProcesses.length);
        resolve(true);
    });
}

function expandFilePathInOutput(output: string, cwd: string): string {
    const lines = output.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const matches = lines[i].match(/^\s*(.+.go):(\d+):/);
        if (matches && matches[1] && !path.isAbsolute(matches[1])) {
            lines[i] = lines[i].replace(matches[1], path.join(cwd, matches[1]));
        }
    }
    return lines.join('\n');
}

/**
 * Get the test target arguments.
 *
 * @param testconfig Configuration for the Go extension.
 */
function targetArgs(testconfig: TestConfig): Array<string> {
    let params: string[] = [];

    if (testconfig.functions) {
        if (testconfig.isBenchmark) {
            params = ['-bench', util.format('^(%s)$', testconfig.functions.join('|'))];
        } else {
            let testFunctions = testconfig.functions;
            let checkv1Methods = testFunctions.filter((fn) => testMethodRegex.test(fn));
            if (checkv1Methods.length > 0) {
                // filter out testify methods
                testFunctions = testFunctions.filter((fn) => !testMethodRegex.test(fn));
                checkv1Methods = checkv1Methods.map(extractInstanceTestName);
            }

            // we might skip the '-run' param when running only testify methods, which will result
            // in running all the test methods, but one of them should call testify's `suite.Run(...)`
            // which will result in the correct thing to happen
            if (testFunctions.length > 0) {
                params = params.concat(['-run', util.format('^(%s)$', testFunctions.join('|'))]);
            }
            if (checkv1Methods.length > 0) {
                params = params.concat(['-check.f', util.format('^(%s)$', checkv1Methods.join('|'))]);
            }
        }
        return params;
    }

    if (testconfig.isBenchmark) {
        params = ['-bench', '.'];
    }
    return params;
}

function removeRunFlag(flags: string[]): void {
    const index: number = flags.indexOf('-run');
    if (index !== -1) {
        flags.splice(index, 2);
    }
}
