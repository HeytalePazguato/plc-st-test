(* IEC 61131-3 §6.3.2 / Table 10: REAL is IEEE 754 binary32 and LREAL is binary64, so every REAL result is rounded to single precision. 16777217 (2^24+1) is not representable in binary32 and rounds to 16777216. *)
FUNCTION_BLOCK TEST_RealFround
VAR r, r2 : REAL; l, l2 : LREAL; END_VAR
METHOD Test_SinglePrecisionRoundsInteger
  r := 16777217.0;
  ASSERT_EQUAL_REAL(r, 16777216.0);
END_METHOD
METHOD Test_DoubleKeepsInteger
  l := 16777217.0;
  ASSERT_EQUAL_LREAL(l, 16777217.0);
END_METHOD
METHOD Test_LrealZeroPointOnePlusZeroPointTwo
  l := 0.1; l2 := 0.2;
  ASSERT_NEAR(l + l2, 0.3, 1.0E-15);
  ASSERT_NOT_EQUAL_LREAL(l + l2, 0.3);
END_METHOD
METHOD Test_RealZeroPointOnePlusZeroPointTwo
  r := 0.1; r2 := 0.2;
  ASSERT_EQUAL_REAL(r + r2, 0.3);
END_METHOD
METHOD Test_RealAccumulationAbsorbed
  r := 16777216.0;
  r := r + 1.0;
  ASSERT_EQUAL_REAL(r, 16777216.0);
END_METHOD
METHOD Test_LrealAccumulationKept
  l := 16777216.0;
  l := l + 1.0;
  ASSERT_EQUAL_LREAL(l, 16777217.0);
END_METHOD
METHOD Test_RealStoresRoundedDouble
  l := 0.1;
  r := l;
  l2 := r;
  ASSERT_NOT_EQUAL_LREAL(l2, 0.1);
  ASSERT_NEAR(l2, 0.1, 1.0E-7);
END_METHOD
END_FUNCTION_BLOCK
