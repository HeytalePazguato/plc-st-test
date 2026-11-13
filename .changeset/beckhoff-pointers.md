---
'@plc-st/dialect-beckhoff': patch
'@plc-st/plugin-api': patch
'@plc-st/core': patch
'plc-st-test': patch
---

TwinCAT pointers and references in the Beckhoff dialect: `ADR(x)` yields a `POINTER` handle, `p^` reads and writes through it (also as `pFb^.Method()` and `pSt^.field`), `r REF= x` binds a `REFERENCE TO` / `REF_TO` variable that then auto-dereferences on read and write, `__ISVALIDREF(r)` and `SIZEOF(x)` are host functions, and pointer arithmetic is a runtime error (`pointer arithmetic is not supported (fidelity statement)`). Core gains the `POINTER` / `REFERENCE` scalar types, a per-session slot table, NULL defaults for pointer declarations and reference following; `@plc-st/plugin-api` gains `Dialect.lvalueHandlers` (`LvalueHandler`), three `NodeEvaluator` methods (`rawLvalue`, `handleOf`, `slotOf`) and `HostFnDef.rawArgs`.
