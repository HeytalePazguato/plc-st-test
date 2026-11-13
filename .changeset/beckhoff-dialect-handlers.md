---
'@plc-st/dialect-beckhoff': patch
'@plc-st/plugin-api': patch
'@plc-st/core': patch
'plc-st-test': patch
---

Beckhoff TwinCAT 3 dialect: `beckhoffDialect` (id `beckhoff`) loads the published `tree-sitter-iec61131-3-st-beckhoff` grammar and handles `AND_THEN` / `OR_ELSE` (short-circuit), `S=` / `R=` (set/reset) and pragmas (no-ops); the CLI ships it as a built-in, selected with `dialect: beckhoff`. `NodeHandler` now receives a third `NodeEvaluator` argument from core (`evaluate`, `lvalue`, `store`, `error`) so dialects can evaluate child nodes without importing core.
