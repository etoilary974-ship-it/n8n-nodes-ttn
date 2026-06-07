/**
 * Build without relying on `npm exec -- tsc` (avoids the fake npm "tsc" package on Windows).
 * Mirrors @n8n/node-cli: tsc then copy static assets.
 */
const { existsSync } = require('node:fs');
const { cp, mkdir, rm } = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const rootRequire = createRequire(path.join(root, 'package.json'));

function resolveTscJs() {
	try {
		const resolved = rootRequire.resolve('typescript/lib/tsc.js');
		return existsSync(resolved) ? resolved : null;
	} catch {
		return null;
	}
}

async function main() {
	const tscJs = resolveTscJs();
	if (!tscJs) {
		console.error(
			'TypeScript not found or incomplete install (missing typescript/lib/tsc.js).\n' +
				'Run: npm install\n' +
				'If it persists: rm -rf node_modules && npm install',
		);
		process.exit(1);
	}

	await rm(path.join(root, 'dist'), { recursive: true, force: true });

	const tscRun = spawnSync(process.execPath, [tscJs, '-p', 'tsconfig.json'], {
		cwd: root,
		stdio: 'inherit',
	});
	if (tscRun.status !== 0) {
		process.exit(tscRun.status ?? 1);
	}

	let fg;
	try {
		fg = rootRequire('fast-glob');
	} catch {
		console.error(
			'fast-glob not found or broken install.\n' +
				'Run: rm -rf node_modules && npm install',
		);
		process.exit(1);
	}

	const patterns = ['**/*.{png,svg}', '**/__schema__/**/*.json'];
	const files = fg.sync(patterns, {
		cwd: root,
		ignore: ['dist', 'node_modules'],
	});

	await Promise.all(
		files.map(async (rel) => {
			const from = path.join(root, rel);
			const dest = path.join(root, 'dist', rel);
			await mkdir(path.dirname(dest), { recursive: true });
			return cp(from, dest, { recursive: true });
		}),
	);

	/* n8n resolves file: relative to the node .js folder; ../../icons often breaks (Docker, custom extensions). */
	const ttnNodeDir = path.join(root, 'dist', 'nodes', 'ttn_node');
	await mkdir(ttnNodeDir, { recursive: true });
	for (const name of ['ttnNodeIcon.svg', 'ttnNodeIcon.dark.svg']) {
		const from = path.join(root, 'icons', name);
		if (existsSync(from)) {
			await cp(from, path.join(ttnNodeDir, name));
		}
	}

	console.log('Build finished (tsc + static files).');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
