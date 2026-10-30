(* IEC 61131-3 §6.6.2.5.3 / Table 72 (CASE): selector arms may be single values, comma lists and ranges a..b; ELSE runs when no arm matches; at most one arm runs; enumerated selectors use enumerator labels. *)
TYPE E_Mode : (Off, Manual, Auto, Fault); END_TYPE

FUNCTION_BLOCK TEST_Case
VAR n, r : DINT; m : E_Mode; END_VAR
METHOD Classify
  CASE n OF
    1: r := 10;
    2, 3, 5: r := 20;
    10..19: r := 30;
    -5..-1: r := 40;
  ELSE
    r := 99;
  END_CASE
END_METHOD
METHOD Test_SingleValue
  n := 1; Classify();
  ASSERT_EQUAL_DINT(r, 10);
END_METHOD
METHOD Test_List
  n := 2; Classify();
  ASSERT_EQUAL_DINT(r, 20);
  n := 3; Classify();
  ASSERT_EQUAL_DINT(r, 20);
  n := 5; Classify();
  ASSERT_EQUAL_DINT(r, 20);
END_METHOD
METHOD Test_ListGapFallsToElse
  n := 4; Classify();
  ASSERT_EQUAL_DINT(r, 99);
END_METHOD
METHOD Test_RangeBounds
  n := 10; Classify();
  ASSERT_EQUAL_DINT(r, 30);
  n := 15; Classify();
  ASSERT_EQUAL_DINT(r, 30);
  n := 19; Classify();
  ASSERT_EQUAL_DINT(r, 30);
  n := 9; Classify();
  ASSERT_EQUAL_DINT(r, 99);
  n := 20; Classify();
  ASSERT_EQUAL_DINT(r, 99);
END_METHOD
METHOD Test_NegativeRange
  n := -3; Classify();
  ASSERT_EQUAL_DINT(r, 40);
  n := 0; Classify();
  ASSERT_EQUAL_DINT(r, 99);
END_METHOD
METHOD Test_NoElseNoMatchLeavesUnchanged
  r := 7; n := 50;
  CASE n OF
    1: r := 1;
  END_CASE
  ASSERT_EQUAL_DINT(r, 7);
END_METHOD
METHOD Test_EnumArms
  m := E_Mode.Auto;
  CASE m OF
    E_Mode.Off: r := 0;
    E_Mode.Manual, E_Mode.Auto: r := 1;
    E_Mode.Fault: r := 2;
  END_CASE
  ASSERT_EQUAL_DINT(r, 1);
  m := E_Mode.Fault;
  CASE m OF
    E_Mode.Off: r := 0;
    E_Mode.Manual, E_Mode.Auto: r := 1;
    E_Mode.Fault: r := 2;
  END_CASE
  ASSERT_EQUAL_DINT(r, 2);
END_METHOD
METHOD Test_EnumElse
  m := E_Mode.Manual;
  CASE m OF
    E_Mode.Off: r := 0;
  ELSE
    r := -1;
  END_CASE
  ASSERT_EQUAL_DINT(r, -1);
END_METHOD
METHOD Test_OnlyFirstMatchingArmRuns
  n := 2; r := 0;
  CASE n OF
    1..5: r := r + 1;
    2: r := r + 100;
  END_CASE
  ASSERT_EQUAL_DINT(r, 1);
END_METHOD
END_FUNCTION_BLOCK
