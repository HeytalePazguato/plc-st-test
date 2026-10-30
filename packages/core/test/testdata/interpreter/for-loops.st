(* IEC 61131-3 §6.6.2.5.4 / Table 72 (FOR): the body runs while the control variable has not passed the end value in the direction of BY; a negative BY counts down; when start already passes end the body runs zero times. *)
FUNCTION_BLOCK TEST_ForLoops
VAR i, n, sum : DINT; END_VAR
METHOD Test_NegativeStep
  sum := 0; n := 0;
  FOR i := 10 TO 1 BY -3 DO
    sum := sum + i;
    n := n + 1;
  END_FOR
  ASSERT_EQUAL_DINT(sum, 22);
  ASSERT_EQUAL_DINT(n, 4);
END_METHOD
METHOD Test_ZeroIterations
  n := 0;
  FOR i := 5 TO 4 DO
    n := n + 1;
  END_FOR
  ASSERT_EQUAL_DINT(n, 0);
END_METHOD
METHOD Test_ZeroIterationsNegativeStep
  n := 0;
  FOR i := 1 TO 5 BY -1 DO
    n := n + 1;
  END_FOR
  ASSERT_EQUAL_DINT(n, 0);
END_METHOD
METHOD Test_SingleIteration
  n := 0;
  FOR i := 3 TO 3 DO
    n := n + 1;
  END_FOR
  ASSERT_EQUAL_DINT(n, 1);
END_METHOD
METHOD Test_DefaultStepOne
  sum := 0;
  FOR i := 1 TO 5 DO
    sum := sum + i;
  END_FOR
  ASSERT_EQUAL_DINT(sum, 15);
END_METHOD
METHOD Test_PositiveStepTwo
  sum := 0;
  FOR i := 0 TO 10 BY 2 DO
    sum := sum + i;
  END_FOR
  ASSERT_EQUAL_DINT(sum, 30);
END_METHOD
METHOD Test_LastValueSeenInBody
  FOR i := 1 TO 3 DO
    n := i;
  END_FOR
  ASSERT_EQUAL_DINT(n, 3);
END_METHOD
METHOD Test_NegativeRange
  sum := 0;
  FOR i := -2 TO 2 DO
    sum := sum + i * i;
  END_FOR
  ASSERT_EQUAL_DINT(sum, 10);
END_METHOD
END_FUNCTION_BLOCK
