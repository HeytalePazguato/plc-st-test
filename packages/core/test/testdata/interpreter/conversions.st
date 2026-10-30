(* IEC 61131-3 §6.6.1 Table 30 note on conversion: REAL/LREAL to an integer type rounds to nearest, ties to even (so 0.5 -> 0, 1.5 -> 2, 2.5 -> 2, -0.5 -> 0, -1.5 -> -2); integer narrowing keeps the low-order bits (two's complement wrap); BOOL converts to 0/1. *)
FUNCTION_BLOCK TEST_Conversions
VAR r : REAL; l : LREAL; i : INT; d : DINT; END_VAR
METHOD Test_RealToIntTiesToEven
  r := 0.5;
  ASSERT_EQUAL_DINT(REAL_TO_DINT(r), 0);
  r := 1.5;
  ASSERT_EQUAL_DINT(REAL_TO_DINT(r), 2);
  r := 2.5;
  ASSERT_EQUAL_DINT(REAL_TO_DINT(r), 2);
  r := 3.5;
  ASSERT_EQUAL_DINT(REAL_TO_DINT(r), 4);
END_METHOD
METHOD Test_NegativeTiesToEven
  r := -0.5;
  ASSERT_EQUAL_DINT(REAL_TO_DINT(r), 0);
  r := -1.5;
  ASSERT_EQUAL_DINT(REAL_TO_DINT(r), -2);
  r := -2.5;
  ASSERT_EQUAL_DINT(REAL_TO_DINT(r), -2);
END_METHOD
METHOD Test_NonTiesRoundToNearest
  l := 2.4;
  ASSERT_EQUAL_DINT(LREAL_TO_DINT(l), 2);
  l := 2.6;
  ASSERT_EQUAL_DINT(LREAL_TO_DINT(l), 3);
  l := -2.6;
  ASSERT_EQUAL_DINT(LREAL_TO_DINT(l), -3);
END_METHOD
METHOD Test_IntNarrowingWraps
  d := 300;
  ASSERT_EQUAL_SINT(DINT_TO_SINT(d), 44);
  d := 70000;
  ASSERT_EQUAL_INT(DINT_TO_INT(d), 4464);
  d := -1;
  ASSERT_EQUAL_USINT(DINT_TO_USINT(d), 255);
END_METHOD
METHOD Test_WideningPreservesValue
  i := -5;
  ASSERT_EQUAL_DINT(INT_TO_DINT(i), -5);
  ASSERT_EQUAL_LINT(INT_TO_LINT(i), -5);
  ASSERT_EQUAL_REAL(INT_TO_REAL(i), -5.0);
END_METHOD
METHOD Test_BoolConversions
  ASSERT_EQUAL_DINT(BOOL_TO_DINT(TRUE), 1);
  ASSERT_EQUAL_DINT(BOOL_TO_DINT(FALSE), 0);
  d := 7;
  ASSERT_TRUE(DINT_TO_BOOL(d));
  d := 0;
  ASSERT_FALSE(DINT_TO_BOOL(d));
END_METHOD
METHOD Test_UnsignedFromNegativeWraps
  d := -1;
  ASSERT_EQUAL_UDINT(DINT_TO_UDINT(d), 4294967295);
END_METHOD
END_FUNCTION_BLOCK
