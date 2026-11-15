FUNCTION_BLOCK TEST_Lifecycle
VAR
  bExited : BOOL;
  fbPlain : FB_Widget;
  fbArg : FB_Widget(nInitial := 5, pFlag := ADR(bExited));
  sTen : STRING(10) := 'ABCDEFGHIJKLMNOP';
  pWidget : POINTER TO FB_Widget;
  pWidgets : POINTER TO ARRAY[0..2] OF FB_Widget;
  nTask : INT;
END_VAR
METHOD Test_FbInitRunsWithoutArguments
  ASSERT_EQUAL(1, fbPlain.nInitCalls);
  ASSERT_EQUAL(0, fbPlain.nValue);
END_METHOD
METHOD Test_FbInitTakesTheDeclarationArgument
  ASSERT_EQUAL(1, fbArg.nInitCalls);
  ASSERT_EQUAL(5, fbArg.nValue);
END_METHOD
METHOD Test_StringLengthIsHonoured
  ASSERT_EQUAL(11, SIZEOF(sTen));
  ASSERT_EQUAL(10, LEN(sTen));
END_METHOD
METHOD Test_NewReturnsAUsablePointer
  pWidget := __NEW(FB_Widget);
  ASSERT_TRUE(pWidget <> 0);
  pWidget^.Bump();
  pWidget^.Bump();
  ASSERT_EQUAL(2, pWidget^.nValue);
  ASSERT_EQUAL(1, pWidget^.nInitCalls);
END_METHOD
METHOD Test_NewArrayAllocatesEveryElement
  pWidgets := __NEW(FB_Widget, 3);
  pWidgets^[1].Bump();
  ASSERT_EQUAL(1, pWidgets^[1].nValue);
  ASSERT_EQUAL(1, pWidgets^[2].nInitCalls);
END_METHOD
METHOD Test_DeleteRunsFbExitAndNullsThePointer
  pWidget := __NEW(FB_Widget);
  pWidget^.pExited := ADR(bExited);
  ASSERT_FALSE(bExited);
  __DELETE(pWidget);
  ASSERT_TRUE(bExited);
  ASSERT_TRUE(pWidget = 0);
END_METHOD
METHOD Test_FbReinitRunsOnTheLiveInstance
  fbArg.Bump();
  ASSERT_EQUAL(6, fbArg.nValue);
  FB_REINIT('fbArg');
  ASSERT_EQUAL(0, fbArg.nValue);
END_METHOD
METHOD Test_SystemTaskIndexIsZero
  nTask := __SYSTEM.GetCurrentTaskIndex();
  ASSERT_EQUAL(0, nTask);
END_METHOD
END_FUNCTION_BLOCK
