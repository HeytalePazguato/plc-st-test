# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — next: 0.0.1

### Added

- Package skeletons for the rest of the monorepo — `@plc-st/plugin-api`, `@plc-st/project-model`, the `plc-st-test` CLI (`src/cli.ts` moved to `packages/cli`), `@plc-st/ingestor-{generic,twincat,br}` and `@plc-st/dialect-{standard,twincat,br}` — each with TypeScript project references, a Vitest project, and a smoke test; `pnpm build` now builds all ten packages in dependency order. Dependency boundaries (project-model imports nothing, plugin-api only project-model, ingestors never core/CLI/dialects, dialects never core/ingestors) are enforced by ESLint `no-restricted-imports` per package glob and by `test/architecture.test.ts`, which checks every `packages/**/package.json` and all source imports.
- `parseExpressionFragment` / `parseStatementFragment` parse an ST expression or statement list by wrapping it in a throwaway POU, throwing `IecError('invalid fragment: …')` with a fragment-relative position on syntax errors; plus a grammar-compatibility test (`abiVersion >= 14`, zero diagnostics on an FB/IF/CASE/FOR/METHOD sample).
- Single-package TypeScript scaffold: strict `tsconfig` (ES2022 / NodeNext), vitest, eslint flat config, pnpm via corepack, and a `ci.yml` matrix across Ubuntu / macOS / Windows on Node 20 and 22.
- Parser wrapper over `web-tree-sitter` that loads the `tree-sitter-iec61131-3-st` `.wasm` grammar (`initParser`, `parseSource`, `walk`) and surfaces ERROR / MISSING nodes as diagnostics with 1-based line and column.
- Numeric fidelity module: `IecType`, exact two's-complement `wrapInt`, `froundReal` for 32-bit REAL, IEC implicit-widening, and BigInt arithmetic for the 64-bit types (LINT / ULINT / LWORD).
- Runtime value model: the `IecValue` union plus `defaultValue`, deep `cloneValue`, and bit-exact `valueEquals`.
- Cross-file symbol table: POUs, VAR blocks, TYPE declarations (enums / structs), and FB-instance detection, with a `caseSensitive` mode for dialects such as B&R.
- Interpreter foundation shared by the upcoming interpreter tasks: the `EvalContext` / `Slot` / `CallPou` / `ControlSignal` contracts, `DEFAULT_LIMITS`, and the `IecTimeoutError` class.
- `hotfix/<version>` branch convention for emergency patches cut directly from `main` when `develop` has unfinished work that can't ship.
- Repo settings now enable `delete_branch_on_merge=true` via `gh repo edit`.

### Changed

- Parser API is now multi-grammar: `loadGrammar(wasmPath)` initialises web-tree-sitter once and caches one `Language` per absolute path, `baseGrammarPath()` resolves the bundled base grammar, and `parseSource(language, source, filePath)` takes the language explicitly (replacing the module-global `initParser()`).
- Converted the repository to a pnpm workspace monorepo: the existing engine moved (history preserved via `git mv`) to `packages/core` as `@plc-st/core`, the root `package.json` is now the private `plc-st-test-monorepo` workspace root, builds use TypeScript project references (`tsc -b` with `tsconfig.base.json`), and Vitest runs per-package via `test.projects`. Toolchain bumped to pnpm 11.28.9, Node >=24, TypeScript ~6.0.3, Vitest 5, ESLint 10, typescript-eslint 8.72, `@types/node` ~24, and `web-tree-sitter` ~0.27.1.
- Pin `tree-sitter-iec61131-3-st` to 0.1.2, whose external scanner reserves the `END_*` terminators; a forgotten `END_IF` now yields a precise `MISSING "END_IF"` node instead of collapsing the whole POU into a single error.
- Branch flow diagram now shows two paths to `main`: `release/*` for planned releases and `hotfix/*` for emergency patches. PRs to `main` must originate from one of these two — never from `develop` directly, because the `delete_branch_on_merge` setting would wipe `develop` on the remote on every release.

### Why

Discovered while shipping the first 0.0.1 of a project that used this blueprint: when CI/release-workflow fixes were PR'd from `develop` directly to `main`, the auto-delete-on-merge setting deleted `develop` on the remote each time. The fix is procedural — always route through `release/*` or `hotfix/*` — so the blueprint now codifies that.

<!--
  Add entries here while working on `develop` or `release/*`. The heading carries the next target version (`next: X.Y.Z`) so it's obvious what these entries will ship as. On release, rename to `[X.Y.Z] - YYYY-MM-DD` and start a new `[Unreleased] — next: X.Y.Z+1` block.

  Use these subsections, omitting any that don't apply:
    ### Added       — new features
    ### Changed     — changes in existing functionality
    ### Deprecated  — soon-to-be removed features
    ### Removed     — removed features
    ### Fixed       — bug fixes
    ### Security    — vulnerability fixes
-->
