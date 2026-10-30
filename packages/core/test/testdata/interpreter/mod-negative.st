(* IEC 61131-3 §6.6.1.4 Table 30 (MOD): IN1 MOD IN2 = IN1 - (IN1/IN2)*IN2 with truncating division, so the result takes the sign of the dividend. *)
FUNCTION_BLOCK TEST_ModNegative
VAR a, b : DINT; la, lb : LINT; END_VAR
METHOD Test_PositivePositive
  a := 7; b := 3;
  ASSERT_EQUAL_DINT(a MOD b, 1);
END_METHOD
METHOD Test_NegativeDividend
  a := -7; b := 3;
  ASSERT_EQUAL_DINT(a MOD b, -1);
END_METHOD
METHOD Test_NegativeDivisor
  a := 7; b := -3;
  ASSERT_EQUAL_DINT(a MOD b, 1);
END_METHOD
METHOD Test_BothNegative
  a := -7; b := -3;
  ASSERT_EQUAL_DINT(a MOD b, -1);
END_METHOD
METHOD Test_ExactMultipleIsZero
  a := -9; b := 3;
  ASSERT_EQUAL_DINT(a MOD b, 0);
END_METHOD
METHOD Test_BigIntNegative
  la := -7; lb := 3;
  ASSERT_EQUAL_LINT(la MOD lb, -1);
  la := 7; lb := -3;
  ASSERT_EQUAL_LINT(la MOD lb, 1);
END_METHOD
END_FUNCTION_BLOCK
