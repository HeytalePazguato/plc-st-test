(* IEC 61131-3 §6.6.2.4 / Table 72 (RETURN): RETURN ends the current POU invocation immediately; statements after it are not executed, a result assigned before RETURN is the returned value, and only the current method is left, not the caller. *)
FUNCTION_BLOCK FB_Guard
VAR
  calls : DINT;
  reached : DINT;
END_VAR
METHOD Early : DINT
VAR_INPUT x : DINT; END_VAR
  calls := calls + 1;
  Early := 1;
  IF x < 0 THEN
    RETURN;
  END_IF
  reached := reached + 1;
  Early := 2;
END_METHOD
METHOD InLoop : DINT
VAR_INPUT limit : DINT; END_VAR
VAR k : DINT; END_VAR
  FOR k := 1 TO 100 DO
    IF k = limit THEN
      InLoop := k;
      RETURN;
    END_IF
  END_FOR
  InLoop := -1;
END_METHOD
METHOD Inner
  RETURN;
END_METHOD
METHOD Outer : DINT
  Outer := 10;
  Inner();
  Outer := Outer + 1;
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK TEST_ReturnMethod
VAR g : FB_Guard; r : DINT; END_VAR
METHOD Test_ReturnSkipsRest
  r := g.Early(-1);
  ASSERT_EQUAL_DINT(r, 1);
  ASSERT_EQUAL_DINT(g.reached, 0);
END_METHOD
METHOD Test_NoReturnRunsToEnd
  r := g.Early(5);
  ASSERT_EQUAL_DINT(r, 2);
  ASSERT_EQUAL_DINT(g.reached, 1);
END_METHOD
METHOD Test_ReturnFromInsideLoop
  r := g.InLoop(7);
  ASSERT_EQUAL_DINT(r, 7);
  r := g.InLoop(1000);
  ASSERT_EQUAL_DINT(r, -1);
END_METHOD
METHOD Test_ReturnDoesNotLeaveCaller
  r := g.Outer();
  ASSERT_EQUAL_DINT(r, 11);
END_METHOD
METHOD Test_ReturnInTestMethodStopsIt
  r := 1;
  RETURN;
  r := 2;
  ASSERT_EQUAL_DINT(r, 1);
END_METHOD
METHOD Test_StateAfterReturn
  r := g.Early(-1);
  r := g.Early(-1);
  ASSERT_EQUAL_DINT(g.calls, 2);
END_METHOD
END_FUNCTION_BLOCK
