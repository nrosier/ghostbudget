const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');
const prettierPlugin = require('eslint-plugin-prettier');
const security = require('eslint-plugin-security');
const typescript = require('@typescript-eslint/eslint-plugin');
const typescriptParser = require('@typescript-eslint/parser');

module.exports = [
  // eslint-plugin-security was a devDependency, was named in the CI job title, and
  // was listed in SECURITY.md as an implemented control — but it was never
  // registered here, so `npm run lint` exited 0 having run none of its 14 rules.
  security.configs.recommended,
  {
    files: ['**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
      prettier: prettierPlugin,
    },
    rules: {
      'prettier/prettier': 'error',
      'no-console': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
    settings: {
      node: true,
      jest: true,
    },
  },
  {
    // Tests build paths from os.tmpdir() and fixture names, and assert on
    // deliberately hostile input. The filesystem rule fires on every one of those
    // and has nothing to say about them.
    files: ['tests/**/*.js', 'jest.setup.js'],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  prettier,
];
