(* IEC 61131-3 §6.6.3.2 / Tables 41-42 (CTU, CTD) and R_TRIG/F_TRIG (Table 40): counters count only on a rising edge of CU/CD evaluated once per cycle, so holding the input TRUE for many cycles counts once; CTU.Q = (CV >= PV); R_TRIG.Q is TRUE for exactly the cycle in which CLK rose. *)
FUNCTION_BLOCK TEST_CountersEdges
VAR
  ctu : CTU;
  rt : R_TRIG;
  ft : F_TRIG;
  clk : BOOL;
  rst : BOOL;
  rises, falls : DINT;
END_VAR
METHOD Cycle
  ctu(CU := clk, R := rst, PV := 3);
  rt(CLK := clk);
  ft(CLK := clk);
  IF rt.Q THEN rises := rises + 1; END_IF
  IF ft.Q THEN falls := falls + 1; END_IF
END_METHOD
METHOD Test_HeldInputCountsOnce
  clk := TRUE;
  RUN_CYCLES(10);
  ASSERT_EQUAL_INT(ctu.CV, 1);
  ASSERT_EQUAL_DINT(rises, 1);
  ASSERT_EQUAL_DINT(falls, 0);
END_METHOD
METHOD Test_ToggleCountsEachRisingEdge
  clk := TRUE;  RUN_CYCLES(1);
  clk := FALSE; RUN_CYCLES(1);
  clk := TRUE;  RUN_CYCLES(1);
  clk := FALSE; RUN_CYCLES(1);
  ASSERT_EQUAL_INT(ctu.CV, 2);
  ASSERT_EQUAL_DINT(rises, 2);
  ASSERT_EQUAL_DINT(falls, 2);
  ASSERT_FALSE(ctu.Q);
END_METHOD
METHOD Test_QSetsAtPreset
  clk := TRUE;  RUN_CYCLES(1);
  clk := FALSE; RUN_CYCLES(1);
  clk := TRUE;  RUN_CYCLES(1);
  clk := FALSE; RUN_CYCLES(1);
  clk := TRUE;  RUN_CYCLES(1);
  ASSERT_EQUAL_INT(ctu.CV, 3);
  ASSERT_TRUE(ctu.Q);
END_METHOD
METHOD Test_ResetClearsCountAndQ
  clk := TRUE;  RUN_CYCLES(1);
  clk := FALSE; RUN_CYCLES(1);
  clk := TRUE;  RUN_CYCLES(1);
  clk := FALSE; RUN_CYCLES(1);
  clk := TRUE;  RUN_CYCLES(1);
  rst := TRUE;
  RUN_CYCLES(1);
  ASSERT_EQUAL_INT(ctu.CV, 0);
  ASSERT_FALSE(ctu.Q);
END_METHOD
METHOD Test_PulseOnlyOneCycleWide
  clk := TRUE;
  RUN_CYCLES(1);
  ASSERT_TRUE(rt.Q);
  RUN_CYCLES(1);
  ASSERT_FALSE(rt.Q);
END_METHOD
END_FUNCTION_BLOCK
