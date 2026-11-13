FUNCTION_BLOCK TEST_Cond
VAR
  x : INT := 1;
END_VAR
METHOD Test_SelectsRegion
{IF defined (bSim)}
  ASSERT_TRUE(x = 2);
{ELSIF defined (bOther)}
  ASSERT_TRUE(x = 3);
{ELSE}
  ASSERT_TRUE(x = 1);
{END_IF}
END_METHOD
END_FUNCTION_BLOCK
