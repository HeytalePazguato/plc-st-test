# Running cycles: RUN_CYCLES and RUN_UNTIL

A PLC program is driven by a scan cycle, and a unit test needs to say "let the controller scan N times" without a real runtime. plc-st-test provides two host functions for this, available in every test: `RUN_CYCLES` and `RUN_UNTIL`. Both operate on the current test's own cycle engine and on the current test's suite instance, so tests never share cycle counters, clocks or timers.

## What one cycle does

Each cycle runs these steps, in this order: the cycle counter is incremented (the first cycle of a test is cycle 1); the simulated clock advances by the cycle time; the session's `preCycle` hooks run (simulators use these to update inputs); the suite's `Cycle` method is called, if the suite declares one; `VAR_TEMP` is reset for the suite and every function block instance reached from it; and the session's `postCycle` hooks run (simulators use these to publish outputs). The `Cycle` method is the place to call the unit under test, for example `uut();`, so that `RUN_CYCLES` exercises it.

The clock is simulated and only moves when a cycle runs, so `TON`, `TOF` and `TP` timers elapse deterministically: with a 10 ms cycle time, a `T#100ms` timer elapses after 10 cycles regardless of how fast the host machine is. The default cycle time is 10 ms and is configurable through `cycle_time` in the project configuration.

## RUN_CYCLES(n: DINT)

Runs `n` cycles. `n = 0` does nothing. A negative `n` raises a runtime error and the test is reported as errored.

## RUN_UNTIL(expr: STRING, maxCycles: DINT): DINT

Runs cycles until the BOOL expression `expr` is TRUE and returns the number of cycles consumed. The expression is given as a string, because it has to be re-evaluated after every cycle rather than once at the call site. It is parsed once, in the scope of the suite (so it can name the suite's variables, such as `uut.eState = E_CalcState.IDLE`), and evaluated after each cycle; it is not evaluated before the first cycle, so at least one cycle always runs. If the expression is still FALSE after `maxCycles` cycles, `RUN_UNTIL` raises a timeout, which is reported as a failed test with failure kind `timeout` and a message naming the expression, for example `RUN_UNTIL(uut.nTicks > 100) not TRUE after 4 cycles`. An expression that does not evaluate to BOOL is a runtime error.

## Cycle budget

`limits.max_cycles_per_test` (default 100000) caps the total number of cycles one test may run, counted cumulatively across all `RUN_CYCLES` and `RUN_UNTIL` calls. Exceeding it is an errored test with failure kind `limit`, as opposed to a `RUN_UNTIL` timeout, which is a failed test: the timeout is the test's own expectation not being met, while the budget is a guard against runaway tests.

## Outside a test

Both functions raise `RUN_CYCLES can only be used inside a test` (or the `RUN_UNTIL` equivalent) when called while no test is running.

## Examples

Run a fixed number of cycles and assert on the resulting state:

```iecst
FUNCTION_BLOCK TEST_Calc
VAR
  uut : FB_Calc;
  n : DINT;
END_VAR

METHOD Cycle
  uut();
END_METHOD

METHOD Test_StateMachineReachesIdleAfterReset
  uut.Reset();
  RUN_CYCLES(5);
  ASSERT_EQUAL(uut.eState, E_CalcState.IDLE, 'should be idle five cycles after reset');
END_METHOD
END_FUNCTION_BLOCK
```

Wait for a condition and assert on how long it took (`n` is a `DINT` variable of the suite):

```iecst
METHOD Test_FinishesWithinThreeCycles
  uut.Reset();
  n := RUN_UNTIL('uut.eState = E_CalcState.IDLE', 10);
  ASSERT_EQUAL(n, 3, 'idle after exactly three cycles');
END_METHOD
```
