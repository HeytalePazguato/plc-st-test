(* IEC 61131-3 §6.6.1 / Table 30 (ANY_NUM typing): in a mixed-type operation both operands widen to the wider type, so SINT+INT is INT, INT+DINT is DINT, DINT+REAL is REAL, REAL+LREAL is LREAL; the operation is evaluated at the wider type and does not wrap at the narrower one. *)
FUNCTION_BLOCK TEST_Widening
VAR s : SINT; i : INT; d : DINT; r : REAL; l : LREAL; u : USINT; END_VAR
METHOD Test_SintPlusIntIsInt
  s := 100; i := 1000;
  ASSERT_EQUAL_INT(s + i, 1100);
END_METHOD
METHOD Test_SintPlusSintWrapsAtSint
  s := 100;
  s := s + s;
  ASSERT_EQUAL_SINT(s, -56);
END_METHOD
METHOD Test_NoNarrowWrapInWiderExpression
  s := 100; i := 0;
  d := s + i + s;
  ASSERT_EQUAL_DINT(d, 200);
END_METHOD
METHOD Test_IntPlusDintIsDint
  i := 30000; d := 100000;
  ASSERT_EQUAL_DINT(i + d, 130000);
END_METHOD
METHOD Test_DintPlusRealIsReal
  d := 3; r := 0.5;
  ASSERT_EQUAL_REAL(d + r, 3.5);
END_METHOD
METHOD Test_RealPlusLrealIsLreal
  r := 1.5; l := 0.25;
  ASSERT_EQUAL_LREAL(r + l, 1.75);
END_METHOD
METHOD Test_IntTimesDint
  i := 20000; d := 2;
  ASSERT_EQUAL_DINT(i * d, 40000);
END_METHOD
METHOD Test_UsintPlusSintIsInt
  u := 200; s := -100;
  ASSERT_EQUAL_INT(u + s, 100);
END_METHOD
END_FUNCTION_BLOCK
