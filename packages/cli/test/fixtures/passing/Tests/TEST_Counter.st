FUNCTION_BLOCK TEST_Counter
VAR
  uut : FB_Counter;
END_VAR
METHOD Test_CountsWhenEnabled
  uut(bEnable := TRUE);
  uut(bEnable := TRUE);
  ASSERT_EQUAL_DINT(uut.nCount, 2);
END_METHOD
METHOD Test_HoldsWhenDisabled
  uut(bEnable := FALSE);
  ASSERT_EQUAL_DINT(uut.nCount, 0);
END_METHOD
END_FUNCTION_BLOCK
