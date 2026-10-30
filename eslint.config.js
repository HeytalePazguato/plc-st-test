import js from '@eslint/js'
import tseslint from 'typescript-eslint'

const restrict = (patterns) => ({ 'no-restricted-imports': ['error', { patterns }] })
const ban = (group, message) => ({ group, message })

// Dependency-boundary rules (see CONTRIBUTING.md). test/architecture.test.ts enforces the same rules on package.json files and source imports.
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'docs/', '**/dist/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/project-model/**/*.ts'],
    rules: restrict([ban(['@plc-st/*', 'plc-st-test', 'plc-st-test/*'], '@plc-st/project-model must not import any other workspace package.')]),
  },
  {
    files: ['packages/plugin-api/**/*.ts'],
    rules: restrict([ban(['@plc-st/*', '!@plc-st/project-model', 'plc-st-test', 'plc-st-test/*'], '@plc-st/plugin-api may only import @plc-st/project-model (and web-tree-sitter types).')]),
  },
  {
    files: ['packages/ingestors/**/*.ts'],
    rules: restrict([ban(['@plc-st/core', '@plc-st/core/*', '@plc-st/dialect-*', 'plc-st-test', 'plc-st-test/*'], 'Ingestors must not import @plc-st/core, the CLI, or dialects.')]),
  },
  {
    files: ['packages/dialects/**/*.ts'],
    rules: restrict([ban(['@plc-st/core', '@plc-st/core/*', '@plc-st/ingestor-*', 'plc-st-test', 'plc-st-test/*'], 'Dialects must not import @plc-st/core, the CLI, or ingestors.')]),
  },
)
