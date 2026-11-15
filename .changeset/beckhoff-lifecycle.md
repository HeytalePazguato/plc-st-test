---
'@plc-st/dialect-beckhoff': patch
'@plc-st/plugin-api': patch
'@plc-st/core': patch
'plc-st-test': patch
---

TwinCAT function block lifecycle and intrinsics in the Beckhoff dialect: `FB_init(bInitRetains := FALSE, bInCopyCode := FALSE, <extra inputs>)` runs on a new instance whose function block declares it (extra inputs from the declaration, `fb : FB_X(nParam := 5)`), `FB_exit(bInCopyCode := FALSE)` runs on dispose, `FB_REINIT('path')` calls `FB_reinit` on a live instance, `__NEW(T)` / `__NEW(T, n)` allocate an instance or array and return a pointer, `__DELETE(p)` disposes and nulls it, and `__SYSTEM.GetCurrentTaskIndex()` returns 0 (any other `__SYSTEM` intrinsic is a runtime error naming it). A declared `STRING(n)` length is now honoured. `@plc-st/plugin-api` gains `NodeEvaluator.allocate` / `free`, `HostCallContext.instanceAt` / `error` and a third `initArgs` parameter on `DialectHooks.onInstantiate`; core's `VarEntry` carries the declaration's `initArgs` and the slot table can free allocations.
