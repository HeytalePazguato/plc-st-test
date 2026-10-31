---
'@plc-st/core': patch
---

Exceeding `max_loop_iterations` now raises `IecLimitError`, so the test is reported as errored with failure kind `limit` like the other limits (it was `runtime`). The GitHub job summary escapes `&` and drops control characters in table cells.
