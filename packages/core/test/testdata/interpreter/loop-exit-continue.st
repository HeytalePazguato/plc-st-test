(* IEC 61131-3 §6.6.2.5.4 (EXIT) and ed.3 CONTINUE: EXIT leaves only the innermost enclosing loop; CONTINUE skips to the next iteration of the innermost loop. Applies to FOR, WHILE and REPEAT. *)
FUNCTION_BLOCK TEST_LoopExitContinue
VAR i, j, n, outer, inner : DINT; END_VAR
METHOD Test_ExitLeavesInnermostOnly
  outer := 0; inner := 0;
  FOR i := 1 TO 3 DO
    outer := outer + 1;
    FOR j := 1 TO 10 DO
      IF j = 3 THEN EXIT; END_IF
      inner := inner + 1;
    END_FOR
  END_FOR
  ASSERT_EQUAL_DINT(outer, 3);
  ASSERT_EQUAL_DINT(inner, 6);
END_METHOD
METHOD Test_ContinueSkipsRestOfBody
  n := 0;
  FOR i := 1 TO 5 DO
    IF i MOD 2 = 0 THEN CONTINUE; END_IF
    n := n + i;
  END_FOR
  ASSERT_EQUAL_DINT(n, 9);
END_METHOD
METHOD Test_ContinueInInnerOnly
  outer := 0; inner := 0;
  FOR i := 1 TO 2 DO
    outer := outer + 1;
    FOR j := 1 TO 4 DO
      IF j <= 2 THEN CONTINUE; END_IF
      inner := inner + 1;
    END_FOR
  END_FOR
  ASSERT_EQUAL_DINT(outer, 2);
  ASSERT_EQUAL_DINT(inner, 4);
END_METHOD
METHOD Test_ExitFromWhile
  n := 0;
  WHILE TRUE DO
    n := n + 1;
    IF n = 7 THEN EXIT; END_IF
  END_WHILE
  ASSERT_EQUAL_DINT(n, 7);
END_METHOD
METHOD Test_ExitFromRepeat
  n := 0;
  REPEAT
    n := n + 1;
    IF n = 4 THEN EXIT; END_IF
  UNTIL FALSE
  END_REPEAT
  ASSERT_EQUAL_DINT(n, 4);
END_METHOD
METHOD Test_ContinueInRepeatStillEvaluatesUntil
  n := 0; i := 0;
  REPEAT
    i := i + 1;
    IF i < 3 THEN CONTINUE; END_IF
    n := n + 1;
  UNTIL i >= 5
  END_REPEAT
  ASSERT_EQUAL_DINT(n, 3);
  ASSERT_EQUAL_DINT(i, 5);
END_METHOD
METHOD Test_ExitInMixedNesting
  n := 0;
  FOR i := 1 TO 3 DO
    j := 0;
    WHILE TRUE DO
      j := j + 1;
      IF j > 2 THEN EXIT; END_IF
      n := n + 1;
    END_WHILE
  END_FOR
  ASSERT_EQUAL_DINT(n, 6);
END_METHOD
METHOD Test_WhileZeroIterations
  n := 0;
  WHILE FALSE DO n := 1; END_WHILE
  ASSERT_EQUAL_DINT(n, 0);
END_METHOD
METHOD Test_RepeatRunsAtLeastOnce
  n := 0;
  REPEAT n := n + 1; UNTIL TRUE END_REPEAT
  ASSERT_EQUAL_DINT(n, 1);
END_METHOD
END_FUNCTION_BLOCK
