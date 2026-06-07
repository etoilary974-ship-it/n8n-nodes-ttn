import js from '@eslint/js';
import n8nNodesBase from 'eslint-plugin-n8n-nodes-base';
import { globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

/** Legacy paths (ttn_node/, ttn.node.ts) kept for existing installs. */
const legacyStructureRules = {
	'n8n-nodes-base/node-filename-against-convention': 'off',
	'n8n-nodes-base/node-dirname-against-convention': 'off',
	'n8n-nodes-base/cred-filename-against-convention': 'off',
};

export default tseslint.config(
	globalIgnores(['dist', 'node_modules', 'scripts/**', '.prettierrc.js']),
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		plugins: { 'n8n-nodes-base': n8nNodesBase },
		files: ['credentials/**/*.ts', 'nodes/**/*.ts'],
	},
	{ rules: legacyStructureRules },
);
