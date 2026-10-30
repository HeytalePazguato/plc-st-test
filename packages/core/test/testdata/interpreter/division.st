(* IEC 61131-3 §6.6.1.4 / Table 30: division by zero is an error for integer and real operands, and for MOD; this runtime raises IecRuntimeError 'division by zero' (test errored). Also integer division truncates toward zero. *)
FUNCTION_BLOCK TEST_Division
VAR i, z : DINT; r, rz : REAL; l, lz : LREAL; END_VAR
METHOD Test_IntDivByZeroErrors
  z := 0; i := 5 / z;
END_METHOD
METHOD Test_RealDivByZeroErrors
  rz := 0.0; r := 1.0 / rz;
END_METHOD
METHOD Test_LrealDivByZeroErrors
  lz := 0.0; l := 1.0 / lz;
END_METHOD
METHOD Test_ModByZeroErrors
  z := 0; i := 5 MOD z;
END_METHOD
METHOD Test_IntDivTruncatesTowardZero
  i := 7; z := 2;
  ASSERT_EQUAL_DINT(i / z, 3);
  i := -7;
  ASSERT_EQUAL_DINT(i / z, -3);
  z := -2;
  ASSERT_EQUAL_DINT(i / z, 3);
  i := 7;
  ASSERT_EQUAL_DINT(i / z, -3);
END_METHOD
METHOD Test_RealDivNormal
  r := 1.0; rz := 4.0;
  ASSERT_EQUAL_REAL(r / rz, 0.25);
END_METHOD
END_FUNCTION_BLOCK
