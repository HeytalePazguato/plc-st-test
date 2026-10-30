FUNCTION_BLOCK TEST_Counter
VAR
  uut : FB_Counter;
END_VAR
METHOD Test_CountsWhenEnabled
  uut(bEnable := TRUE);
  ASSERT_EQUAL_DINT(uut.nCount, 1);
END_METHOD
METHOD Test_WrongExpectation
  uut(bEnable := TRUE);
  ASSERT_EQUAL_DINT(uut.nCount, 2);
END_METHOD
END_FUNCTION_BLOCK
