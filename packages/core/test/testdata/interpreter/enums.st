(* IEC 61131-3 §6.4.4.2 / Table 12 (enumerated data types): enumerators without an explicit value number from 0 and continue from the previous value after an explicit one; a variable of enumerated type starts at its first enumerator unless an initial value is given; enumerators of one type compare by value. *)
TYPE E_Color : (Red, Green := 5, Blue); END_TYPE
TYPE E_Level : (Low, Mid, High) := Mid; END_TYPE

FUNCTION_BLOCK TEST_Enums
VAR
  c : E_Color;
  lv : E_Level;
  c2 : E_Color := E_Color.Blue;
  n : DINT;
END_VAR
METHOD Test_DefaultIsFirstEnumerator
  ASSERT_EQUAL(c, E_Color.Red);
END_METHOD
METHOD Test_DeclaredInitialValue
  ASSERT_EQUAL(c2, E_Color.Blue);
END_METHOD
METHOD Test_TypeLevelDefault
  ASSERT_EQUAL(lv, E_Level.Mid);
END_METHOD
METHOD Test_ExplicitAndImplicitValues
  n := E_Color.Red;
  ASSERT_EQUAL_DINT(n, 0);
  n := E_Color.Green;
  ASSERT_EQUAL_DINT(n, 5);
  n := E_Color.Blue;
  ASSERT_EQUAL_DINT(n, 6);
END_METHOD
METHOD Test_Comparison
  c := E_Color.Green;
  ASSERT_TRUE(c = E_Color.Green);
  ASSERT_TRUE(c <> E_Color.Blue);
  ASSERT_NOT_EQUAL(c, E_Color.Red);
END_METHOD
METHOD Test_AssignAndCopy
  c := E_Color.Blue;
  c2 := c;
  c := E_Color.Red;
  ASSERT_EQUAL(c2, E_Color.Blue);
  ASSERT_EQUAL(c, E_Color.Red);
END_METHOD
END_FUNCTION_BLOCK
