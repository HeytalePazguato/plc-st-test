FUNCTION_BLOCK TEST_Pointers
VAR
  nVal : INT := 3;
  nOther : INT := 40;
  pInt : POINTER TO INT;
  pNull : POINTER TO INT;
  rVal : REFERENCE TO INT;
  rUnbound : REFERENCE TO INT;
  fbCount : FB_Counter;
  pFb : POINTER TO FB_Counter;
  stPair : ST_Pair;
  pPair : POINTER TO ST_Pair;
END_VAR
METHOD Test_AdrAndDerefWriteThrough
  pInt := ADR(nVal);
  ASSERT_EQUAL(3, pInt^);
  pInt^ := 7;
  ASSERT_EQUAL(7, nVal);
  ASSERT_TRUE(pInt <> 0);
  ASSERT_TRUE(pNull = 0);
END_METHOD
METHOD Test_RefAssignAliases
  ASSERT_FALSE(__ISVALIDREF(rUnbound));
  rVal REF= nVal;
  ASSERT_TRUE(__ISVALIDREF(rVal));
  rVal := 11;
  ASSERT_EQUAL(11, nVal);
  nVal := 12;
  ASSERT_EQUAL(12, rVal);
  rVal REF= nOther;
  rVal := rVal + 1;
  ASSERT_EQUAL(41, nOther);
  ASSERT_EQUAL(12, nVal);
END_METHOD
METHOD Test_PointerToFbAndStruct
  pFb := ADR(fbCount);
  pFb^.Bump();
  pFb^.Bump();
  ASSERT_EQUAL(2, fbCount.nCount);
  pPair := ADR(stPair);
  pPair^.nA := 5;
  ASSERT_EQUAL(5, stPair.nA);
END_METHOD
METHOD Test_SizeOf
  ASSERT_EQUAL(2, SIZEOF(nVal));
  ASSERT_EQUAL(6, SIZEOF(stPair));
  ASSERT_EQUAL(8, SIZEOF(pInt));
END_METHOD
END_FUNCTION_BLOCK
