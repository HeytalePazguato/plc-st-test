# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — next: 0.0.1

### Added

- Single-package TypeScript scaffold: strict `tsconfig` (ES2022 / NodeNext), vitest, eslint flat config, pnpm via corepack, and a `ci.yml` matrix across Ubuntu / macOS / Windows on Node 20 and 22.
- Parser wrapper over `web-tree-sitter` that loads the `tree-sitter-iec61131-3-st` `.wasm` grammar (`initParser`, `parseSource`, `walk`) and surfaces ERROR / MISSING nodes as diagnostics with 1-based line and column.
- Numeric fidelity module: `IecType`, exact two's-complement `wrapInt`, `froundReal` for 32-bit REAL, IEC implicit-widening, and BigInt arithmetic for the 64-bit types (LINT / ULINT / LWORD).
- Runtime value model: the `IecValue` union plus `defaultValue`, deep `cloneValue`, and bit-exact `valueEquals`.
- Cross-file symbol table: POUs, VAR blocks, TYPE declarations (enums / structs), and FB-instance detection, with a `caseSensitive` mode for dialects such as B&R.
- Interpreter foundation shared by the upcoming interpreter tasks: the `EvalContext` / `Slot` / `CallPou` / `ControlSignal` contracts, `DEFAULT_LIMITS`, and the `IecTimeoutError` class.
- `hotfix/<version>` branch convention for emergency patches cut directly from `main` when `develop` has unfinished work that can't ship.
- Repo settings now enable `delete_branch_on_merge=true` via `gh repo edit`.

### Changed

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
