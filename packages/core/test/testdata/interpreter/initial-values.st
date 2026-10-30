(* IEC 61131-3 §6.4.2 / Table 62 (default initial values): every variable without an explicit initializer starts at the type's default (0, FALSE, empty string, T#0s, first enumerator); explicit initializers, including constant expressions and negative literals, override it; FB instances start fresh for every test. *)
FUNCTION_BLOCK TEST_InitialValues
VAR CONSTANT
  K : DINT := 4;
END_VAR
VAR
  i : INT;
  u : UDINT;
  r : REAL;
  b : BOOL;
  s : STRING;
  t : TIME;
  l : LINT;
  neg : INT := -7;
  expr : DINT := K * 2 + 1;
  arr : ARRAY[0..2] OF DINT := [1, 2, 3];
  zeros : ARRAY[0..2] OF BYTE;
END_VAR
METHOD Test_NumericDefaultsAreZero
  ASSERT_EQUAL_INT(i, 0);
  ASSERT_EQUAL_UDINT(u, 0);
  ASSERT_EQUAL_REAL(r, 0.0);
  ASSERT_EQUAL_LINT(l, 0);
END_METHOD
METHOD Test_BoolStringTimeDefaults
  ASSERT_FALSE(b);
  ASSERT_EQUAL_STRING(s, '');
  ASSERT_EQUAL_TIME(t, T#0s);
END_METHOD
METHOD Test_NegativeInitializer
  ASSERT_EQUAL_INT(neg, -7);
END_METHOD
METHOD Test_ConstantExpressionInitializer
  ASSERT_EQUAL_DINT(expr, 9);
END_METHOD
METHOD Test_ArrayInitializer
  ASSERT_EQUAL_DINT(arr[0], 1);
  ASSERT_EQUAL_DINT(arr[2], 3);
  ASSERT_EQUAL_BYTE(zeros[1], 0);
END_METHOD
METHOD Test_StateDoesNotLeakBetweenTests
  i := 42;
  s := 'dirty';
END_METHOD
METHOD Test_FreshAfterDirtyingTest
  ASSERT_EQUAL_INT(i, 0);
  ASSERT_EQUAL_STRING(s, '');
END_METHOD
END_FUNCTION_BLOCK
