(* IEC 61131-3 §6.5.3 / Table 14: VAR keeps its value between invocations of an FB instance, while VAR_TEMP is re-initialised on every invocation. *)
FUNCTION_BLOCK FB_Counter
VAR
  persistent : DINT := 100;
  lastScratch : DINT;
END_VAR
VAR_TEMP
  scratch : DINT := 7;
END_VAR
METHOD Run
  persistent := persistent + 1;
  scratch := scratch + 10;
  lastScratch := scratch;
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_TempOnly
VAR_TEMP
  t : DINT;
END_VAR
VAR
  seenNonZero : BOOL;
END_VAR
METHOD Run
  IF t <> 0 THEN seenNonZero := TRUE; END_IF
  t := t + 5;
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK TEST_TempVsVar
VAR
  c : FB_Counter;
  o : FB_TempOnly;
  runs : DINT;
END_VAR
METHOD Cycle
  c.Run();
  o.Run();
  runs := runs + 1;
END_METHOD
METHOD Test_VarPersistsAcrossCycles
  RUN_CYCLES(5);
  ASSERT_EQUAL_DINT(c.persistent, 105);
  ASSERT_EQUAL_DINT(runs, 5);
END_METHOD
METHOD Test_VarTempResetsEachInvocation
  RUN_CYCLES(4);
  ASSERT_FALSE(o.seenNonZero);
END_METHOD
METHOD Test_VarTempReinitialisedToDeclaredValue
  RUN_CYCLES(3);
  ASSERT_EQUAL_DINT(c.lastScratch, 17);
END_METHOD
END_FUNCTION_BLOCK
