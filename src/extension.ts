import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	console.log('Activated Go Check for Visual Studio Code');
	let disposable = vscode.commands.registerCommand('vscode-go-check.helloWorld', () => {
		vscode.window.showInformationMessage('Go Check for Visual Studio Code');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {
	console.log('Deactivated Go Check for Visual Studio Code');
}
