// Flat config without plugins (eslint is used for correctness rules only)
module.exports = [
  { ignores: ['web/data/**', 'node_modules/**', 'pcbridge/**', 'Code.gs'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', self: 'readonly', localStorage: 'readonly',
        location: 'readonly', navigator: 'readonly', fetch: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', AbortController: 'readonly',
        module: 'writable', require: 'readonly', process: 'readonly', __dirname: 'readonly',
        Blob: 'readonly', URL: 'readonly', FileReader: 'readonly', TextDecoder: 'readonly',
        DecompressionStream: 'readonly', Response: 'readonly', Intl: 'readonly',
        matchMedia: 'readonly', getComputedStyle: 'readonly', Buffer: 'readonly',
        requestAnimationFrame: 'readonly', HTMLElement: 'readonly', Event: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'eqeqeq': ['error', 'smart'],
      'no-implicit-globals': 'error'
    }
  },
  {
    // Node files are CommonJS modules: top-level declarations are module-scoped
    files: ['tests/**/*.js', 'api/**/*.js', 'tools/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { 'no-implicit-globals': 'off' }
  }
];
