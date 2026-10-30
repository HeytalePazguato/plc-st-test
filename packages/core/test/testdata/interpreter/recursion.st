(* IEC 61131-3 §6.6.1.5 leaves recursion implementation-defined (the standard does not permit a function to call itself); this runtime allows bounded recursion and ends a runaway one with a limit error (test errored, kind limit) instead of a stack overflow. *)
FUNCTION F_Factorial : DINT
VAR_INPUT n : DINT; END_VAR
IF n <= 1 THEN
  F_Factorial := 1;
ELSE
  F_Factorial := n * F_Factorial(n - 1);
END_IF
END_FUNCTION

FUNCTION F_Runaway : DINT
VAR_INPUT n : DINT; END_VAR
F_Runaway := F_Runaway(n + 1);
END_FUNCTION

FUNCTION F_Depth : DINT
VAR_INPUT n : DINT; END_VAR
IF n = 0 THEN
  F_Depth := 0;
ELSE
  F_Depth := 1 + F_Depth(n - 1);
END_IF
END_FUNCTION

FUNCTION_BLOCK TEST_Recursion
METHOD Test_FactorialShallow
  ASSERT_EQUAL_DINT(F_Factorial(5), 120);
  ASSERT_EQUAL_DINT(F_Factorial(1), 1);
  ASSERT_EQUAL_DINT(F_Factorial(10), 3628800);
END_METHOD
METHOD Test_RunawayRecursionHitsLimit
  ASSERT_EQUAL_DINT(F_Runaway(0), 0);
END_METHOD
METHOD Test_ModerateDepthOk
  ASSERT_EQUAL_DINT(F_Depth(50), 50);
END_METHOD
END_FUNCTION_BLOCK
