/**
 * Build then copy package.json + dist to the custom n8n folder (Docker / Windows volume).
 * Default target: C:\n8n_data\custom\n8n-nodes-ttn on Windows, ~/n8n_data/custom/n8n-nodes-ttn elsewhere.
 * Override: N8N_CUSTOM_DEPLOY_DIR environment variable.
 */
const { existsSync } = require('node:fs');
const { cp, mkdir, rm } = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

const defaultTarget =
	process.platform === 'win32'
		? 'C:\\n8n_data\\custom\\n8n-nodes-ttn'
		: path.join(process.env.HOME || '', 'n8n_data', 'custom', 'n8n-nodes-ttn');

const target = path.resolve(process.env.N8N_CUSTOM_DEPLOY_DIR || defaultTarget);

async function main() {
	const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-package.cjs')], {
		cwd: root,
		stdio: 'inherit',
	});
	if (build.status !== 0) {
		process.exit(build.status ?? 1);
	}

	const distSrc = path.join(root, 'dist');
	if (!existsSync(distSrc)) {
		console.error('dist/ not found after build.');
		process.exit(1);
	}

	await mkdir(target, { recursive: true });

	const pkgJson = path.join(root, 'package.json');
	await cp(pkgJson, path.join(target, 'package.json'));

	const lock = path.join(root, 'package-lock.json');
	if (existsSync(lock)) {
		await cp(lock, path.join(target, 'package-lock.json'));
	}

	const distDest = path.join(target, 'dist');
	await rm(distDest, { recursive: true, force: true });
	await cp(distSrc, distDest, { recursive: true });

	console.log('');
	console.log('Deploy finished to:', target);
	console.log('Restart the n8n container if needed to reload custom nodes.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
