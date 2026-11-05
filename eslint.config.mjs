import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: [ 'dist/', '.aws-sam/', 'node_modules/', 'tests/test-filesize/output/' ],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	jsdoc.configs['flat/recommended-typescript'],
	{
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			// Matches the existing code style (WordPress spacing).
			'array-bracket-spacing': [ 'error', 'always' ],
			'object-curly-spacing': [ 'error', 'always' ],
			'space-in-parens': [ 'error', 'always', { exceptions: [ 'empty' ] } ],
			// Lambda handlers catch unknown SDK errors and read `.Code`.
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unused-vars': [ 'error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' } ],
			'jsdoc/require-param': 'off',
			'jsdoc/require-returns': 'off',
		},
	},
	{
		// The Lambda handler and its shim are formatted by Prettier
		// (double quotes, no spaces in parens). Do not reformat them here.
		files: [ 'src/lambda-handler.ts', 'src/server.ts' ],
		rules: {
			'array-bracket-spacing': 'off',
			'object-curly-spacing': 'off',
			'space-in-parens': 'off',
		},
	},
	{
		files: [ '*.d.ts' ],
		rules: {
			'no-var': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
		},
	},
	{
		files: [ 'tests/**/*.ts' ],
		rules: {
			'jsdoc/require-jsdoc': 'off',
		},
	}
);
