/* eslint-disable no-process-exit */
import * as path from 'path';
import { runTests } from 'vscode-test';

async function main() {
	// We are in test mode.
	process.env['VSCODE_GO_IN_TEST'] = '1';
	if (process.argv.length > 2) {
		process.env['MOCHA_GREP'] = process.argv[2];
	}

	// The folder containing the Extension Manifest package.json
	// Passed to `--extensionDevelopmentPath`
	const extensionDevelopmentPath = path.resolve(__dirname, '../../');

	let failed = false;

	const version = process.env.CODE_VERSION || undefined;

	try {
		// The path to the extension test script
		// Passed to --extensionTestsPath
		const extensionTestsPath = path.resolve(__dirname, './integration/index');

		// Download VS Code, unzip it and run the integration test
		await runTests({
			version,
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				'--disable-extensions',
				`--user-data-dir=${extensionDevelopmentPath}/.user-data-dir-test`,
				// https://github.com/microsoft/vscode/issues/115794#issuecomment-774283222
				'--force-disable-user-env'
			]
		});
	} catch (err) {
		console.error('Failed to run integration tests' + err);
		failed = true;
	}

	if (failed) {
		process.exit(1);
	}
}

main();
