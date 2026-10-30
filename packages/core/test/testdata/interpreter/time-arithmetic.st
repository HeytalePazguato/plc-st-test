(* IEC 61131-3 §6.3.3 / Table 8-9 (TIME): TIME literals combine units (T#1s500ms = 1500 ms); TIME + TIME, TIME - TIME and TIME * number give TIME; TIME values compare chronologically; TIME has no wraparound at the sizes used here. *)
FUNCTION_BLOCK TEST_TimeArithmetic
VAR a, b : TIME; END_VAR
METHOD Test_CompoundLiteral
  a := T#1s500ms;
  ASSERT_EQUAL_TIME(a, T#1500ms);
END_METHOD
METHOD Test_Addition
  a := T#2s; b := T#750ms;
  ASSERT_EQUAL_TIME(a + b, T#2750ms);
END_METHOD
METHOD Test_Subtraction
  a := T#2s; b := T#750ms;
  ASSERT_EQUAL_TIME(a - b, T#1250ms);
END_METHOD
METHOD Test_Comparison
  a := T#1m; b := T#59s;
  ASSERT_TRUE(a > b);
  ASSERT_TRUE(b < a);
  ASSERT_TRUE(a >= T#60s);
  ASSERT_TRUE(a = T#60s);
  ASSERT_TRUE(a <> b);
END_METHOD
METHOD Test_UnitConversions
  ASSERT_EQUAL_TIME(T#1h, T#60m);
  ASSERT_EQUAL_TIME(T#1d, T#24h);
  ASSERT_EQUAL_TIME(T#1s, T#1000ms);
  ASSERT_EQUAL_TIME(T#1ms, T#1000us);
END_METHOD
METHOD Test_ZeroTime
  a := T#0s;
  ASSERT_EQUAL_TIME(a, T#0ms);
  ASSERT_EQUAL_TIME(a + T#5ms, T#5ms);
END_METHOD
END_FUNCTION_BLOCK
