FUNCTION_BLOCK TEST_Latch
VAR
  uut : FB_Latch;
  a : BOOL := FALSE;
  b : INT := 0;
  x : BOOL;
END_VAR
METHOD Test_AndThenSkipsDivisionByZero
  ASSERT_FALSE(a AND_THEN (1 / b > 0));
  uut(nDivisor := 0);
  ASSERT_FALSE(uut.bRatioOk);
  uut(nDivisor := 5);
  ASSERT_TRUE(uut.bRatioOk);
END_METHOD
METHOD Test_SetLatchesAndResetClears
  x S= TRUE;
  x S= FALSE;
  ASSERT_TRUE(x);
  uut(bSet := TRUE);
  uut(bSet := FALSE);
  ASSERT_TRUE(uut.bLatched);
  uut(bReset := TRUE);
  ASSERT_FALSE(uut.bLatched);
END_METHOD
METHOD Test_PragmasAreSilent
  {attribute 'hide'}
  x := TRUE;
  ASSERT_TRUE(x);
END_METHOD
END_FUNCTION_BLOCK
