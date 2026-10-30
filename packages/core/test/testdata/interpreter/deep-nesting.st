(* IEC 61131-3 §6.6.2 (statements compose freely): IF/ELSIF/ELSE, CASE and loops nest to arbitrary depth with the innermost branch selected by the combined conditions; expressions nest through parentheses with the Table 71 precedence (NOT, **, unary minus, * / MOD, + -, comparisons, AND, XOR, OR). *)
FUNCTION_BLOCK TEST_DeepNesting
VAR a, b, c, r, i, j, k, count : DINT; ok : BOOL; END_VAR
METHOD Test_NestedIfElsifChain
  a := 2; b := 3; c := 4;
  IF a = 1 THEN
    r := 1;
  ELSIF a = 2 THEN
    IF b = 2 THEN
      r := 2;
    ELSIF b = 3 THEN
      IF c = 3 THEN
        r := 3;
      ELSE
        IF c = 4 THEN r := 4; ELSE r := 5; END_IF
      END_IF
    END_IF
  ELSE
    r := 6;
  END_IF
  ASSERT_EQUAL_DINT(r, 4);
END_METHOD
METHOD Test_TripleNestedLoopCount
  count := 0;
  FOR i := 1 TO 4 DO
    FOR j := 1 TO 3 DO
      FOR k := 1 TO 2 DO
        count := count + 1;
      END_FOR
    END_FOR
  END_FOR
  ASSERT_EQUAL_DINT(count, 24);
END_METHOD
METHOD Test_LoopsCaseAndIfTogether
  count := 0;
  FOR i := 1 TO 6 DO
    CASE i MOD 3 OF
      0: count := count + 100;
      1:
        IF i > 3 THEN count := count + 10; ELSE count := count + 1; END_IF
    ELSE
      count := count + 1000;
    END_CASE
  END_FOR
  ASSERT_EQUAL_DINT(count, 2 * 1000 + 2 * 100 + 10 + 1);
END_METHOD
METHOD Test_ParenthesesNestDeeply
  a := 2;
  r := ((((a + 1) * (a + 2)) - ((a - 1) * (a + 3))) * 2) + (((a)));
  ASSERT_EQUAL_DINT(r, 16);
END_METHOD
METHOD Test_PrecedenceTable71
  r := 2 + 3 * 4;
  ASSERT_EQUAL_DINT(r, 14);
  r := 20 - 6 / 3 - 1;
  ASSERT_EQUAL_DINT(r, 17);
  r := 2 * 3 MOD 4;
  ASSERT_EQUAL_DINT(r, 2);
  r := -2 * 3;
  ASSERT_EQUAL_DINT(r, -6);
END_METHOD
METHOD Test_BooleanPrecedence
  ok := TRUE OR FALSE AND FALSE;
  ASSERT_TRUE(ok);
  ok := NOT FALSE AND FALSE;
  ASSERT_FALSE(ok);
  ok := TRUE XOR TRUE OR TRUE;
  ASSERT_TRUE(ok);
  a := 1; b := 2;
  ok := a < b AND b < 3 OR FALSE;
  ASSERT_TRUE(ok);
END_METHOD
METHOD Test_WhileInsideRepeatInsideFor
  count := 0;
  FOR i := 1 TO 2 DO
    j := 0;
    REPEAT
      j := j + 1;
      k := 0;
      WHILE k < 2 DO
        k := k + 1;
        count := count + 1;
      END_WHILE
    UNTIL j >= 3
    END_REPEAT
  END_FOR
  ASSERT_EQUAL_DINT(count, 12);
END_METHOD
END_FUNCTION_BLOCK
