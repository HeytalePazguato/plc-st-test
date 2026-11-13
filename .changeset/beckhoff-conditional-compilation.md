---
'@plc-st/dialect-beckhoff': patch
'@plc-st/plugin-api': patch
'@plc-st/core': patch
'plc-st-test': patch
---

Beckhoff conditional compilation: the dialect's `hooks.preprocess` evaluates `{IF defined (x)}`, `{IF defined (variable: x)}`, `{ELSIF}`, `{ELSE}`, `{END_IF}`, `{define x}` and `{undefine x}` (with `AND`, `OR`, `NOT` and parentheses) against the project and config `defines`, blanking directive lines and excluded regions while keeping every line terminator, so failures report the original file line. `hasattribute`, `hastype` and `hasvalue` are FALSE and raise `PREPROCESS_UNSUPPORTED` run warnings. `DialectHooks.preprocess` gains an optional `warn` callback and `ProjectBuildOptions.preprocess` receives the `SourceUnit`.
