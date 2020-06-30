'use strict';

import * as vscode from 'vscode';
import { GO_MODE } from 'Go/src/goMode';
import { getGoConfig } from 'Go/src/util';
import { cancelRunningTests, showTestOutput } from 'Go/src/testUtils';
import { toggleCoverageCurrentPackage } from 'Go/src/goCover';
// Overriden classes from the Go codebase
import { testAtCursor, testCurrentFile, testCurrentPackage, testPrevious, testWorkspace } from './goTest';
import { GoRunTestCodeLensProvider } from './codeLens';

export function activate(context: vscode.ExtensionContext) {
	const testCodeLensProvider = new GoRunTestCodeLensProvider();
	context.subscriptions.push(vscode.languages.registerCodeLensProvider(GO_MODE, testCodeLensProvider));

	context.subscriptions.push(
		vscode.commands.registerCommand('go.check.test.cursor', (args) => {
			const goConfig = getGoConfig();
			testAtCursor(goConfig, 'test', args);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('go.check.debug.cursor', (args) => {
			const goConfig = getGoConfig();
			testAtCursor(goConfig, 'debug', args);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('go.check.benchmark.cursor', (args) => {
			const goConfig = getGoConfig();
			testAtCursor(goConfig, 'benchmark', args);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('go.check.test.package', (args) => {
			const goConfig = getGoConfig();
			const isBenchmark = false;
			testCurrentPackage(goConfig, isBenchmark, args);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('go.check.benchmark.package', (args) => {
			const goConfig = getGoConfig();
			const isBenchmark = true;
			testCurrentPackage(goConfig, isBenchmark, args);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('go.check.test.file', (args) => {
			const goConfig = getGoConfig();
			const isBenchmark = false;
			testCurrentFile(goConfig, isBenchmark, args);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('go.check.benchmark.file', (args) => {
			const goConfig = getGoConfig();
			const isBenchmark = true;
			testCurrentFile(goConfig, isBenchmark, args);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('go.check.test.workspace', (args) => {
			const goConfig = getGoConfig();
			testWorkspace(goConfig, args);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('go.check.test.previous', () => {
			testPrevious();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('go.check.test.coverage', () => {
			toggleCoverageCurrentPackage();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('go.check.test.showOutput', () => {
			showTestOutput();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('go.check.test.cancel', () => {
			cancelRunningTests();
		})
	);

	console.log('Activated Go Check for Visual Studio Code');
	let disposable = vscode.commands.registerCommand('vscode-go-check.helloWorld', () => {
		vscode.window.showInformationMessage('Go Check for Visual Studio Code');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {
	console.log('Deactivated Go Check for Visual Studio Code');
}
