const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');
const prettierPlugin = require('eslint-plugin-prettier');
const security = require('eslint-plugin-security');

// Globals are listed rather than pulled from the `globals` package, which is not a
// dependency here. The list is exhaustive for this codebase — it was produced by
// running `no-undef` with no globals at all and collecting what it reported — so an
// undeclared global is a lint error rather than something that silently resolves.
const NODE_GLOBALS = {
  URL: 'readonly',
  __dirname: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  global: 'writable',
  process: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
};

const JEST_GLOBALS = {
  afterAll: 'readonly',
  afterEach: 'readonly',
  beforeAll: 'readonly',
  beforeEach: 'readonly',
  describe: 'readonly',
  expect: 'readonly',
  it: 'readonly',
  jest: 'readonly',
};

module.exports = [
  {
    // Flat config reads no .eslintignore, and its only built-in ignore is node_modules.
    ignores: ['coverage/', 'logs/'],
  },
  security.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      // These files are CommonJS, and saying so is what supplies require/module/exports.
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      // Spread into `rules`, not into the config object: a `rules` key in the same
      // object literal replaces what a config-level spread supplied, which is how
      // eslint:recommended came to be configured and inert. See docs/decisions.md.
      ...js.configs.recommended.rules,
      'prettier/prettier': 'error',
      'no-console': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['tests/**/*.js', 'jest.setup.js'],
    languageOptions: {
      globals: { ...NODE_GLOBALS, ...JEST_GLOBALS },
    },
    rules: {
      // Tests build paths from os.tmpdir() and fixture names, and assert on
      // deliberately hostile input. The filesystem rule fires on every one of those
      // and has nothing to say about them.
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  prettier,
];
