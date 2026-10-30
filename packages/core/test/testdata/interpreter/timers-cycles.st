(* IEC 61131-3 §6.6.3.2 / Table 43 (TON), Table 44 (TOF), Table 45 (TP): TON.Q rises once IN has been TRUE for PT and falls with IN; TOF.Q holds for PT after IN falls; TP.Q is a single pulse of width PT regardless of IN. Time is the simulated clock advanced by the fixed cycle time (10 ms per cycle here), so elapsed time is exact. *)
FUNCTION_BLOCK TEST_TimersCycles
VAR
  ton : TON;
  tof : TOF;
  tp : TP;
  inp : BOOL;
  cycles : DINT;
END_VAR
METHOD Cycle
  ton(IN := inp, PT := T#50ms);
  tof(IN := inp, PT := T#50ms);
  tp(IN := inp, PT := T#30ms);
END_METHOD
METHOD Test_TonFiresAfterPreset
  inp := TRUE;
  RUN_CYCLES(4);
  ASSERT_FALSE(ton.Q);
  RUN_CYCLES(2);
  ASSERT_TRUE(ton.Q);
END_METHOD
METHOD Test_TonResetsWhenInputFalls
  inp := TRUE;
  RUN_CYCLES(10);
  ASSERT_TRUE(ton.Q);
  inp := FALSE;
  RUN_CYCLES(1);
  ASSERT_FALSE(ton.Q);
  ASSERT_EQUAL_TIME(ton.ET, T#0ms);
END_METHOD
METHOD Test_TonElapsedSaturatesAtPreset
  inp := TRUE;
  RUN_CYCLES(20);
  ASSERT_EQUAL_TIME(ton.ET, T#50ms);
END_METHOD
METHOD Test_TonShortPulseNeverFires
  inp := TRUE;
  RUN_CYCLES(3);
  inp := FALSE;
  RUN_CYCLES(1);
  inp := TRUE;
  RUN_CYCLES(3);
  ASSERT_FALSE(ton.Q);
END_METHOD
METHOD Test_TofHoldsAfterInputFalls
  inp := TRUE;
  RUN_CYCLES(2);
  ASSERT_TRUE(tof.Q);
  inp := FALSE;
  RUN_CYCLES(3);
  ASSERT_TRUE(tof.Q);
  RUN_CYCLES(4);
  ASSERT_FALSE(tof.Q);
END_METHOD
METHOD Test_TpPulseWidth
  inp := TRUE;
  RUN_CYCLES(1);
  ASSERT_TRUE(tp.Q);
  RUN_CYCLES(1);
  ASSERT_TRUE(tp.Q);
  RUN_CYCLES(5);
  ASSERT_FALSE(tp.Q);
END_METHOD
METHOD Test_TpIgnoresInputFallingMidPulse
  inp := TRUE;
  RUN_CYCLES(1);
  inp := FALSE;
  RUN_CYCLES(1);
  ASSERT_TRUE(tp.Q);
END_METHOD
METHOD Test_RunUntilReturnsCyclesToFire
  inp := TRUE;
  cycles := RUN_UNTIL('ton.Q', 100);
  ASSERT_EQUAL_DINT(cycles, 6);
END_METHOD
END_FUNCTION_BLOCK
