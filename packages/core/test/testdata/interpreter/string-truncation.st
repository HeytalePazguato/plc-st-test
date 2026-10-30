(* IEC 61131-3 §6.3.3 / Table 10 (STRING[n]): a STRING variable declared with length n holds at most n characters; a longer value assigned to it is truncated on the right. *)
FUNCTION_BLOCK TEST_StringTruncation
VAR s : STRING(5); t : STRING(3); u : STRING(255); END_VAR
METHOD Test_AssignTruncates
  s := 'HELLOWORLD';
  ASSERT_EQUAL_STRING(s, 'HELLO');
  ASSERT_EQUAL_INT(LEN(s), 5);
END_METHOD
METHOD Test_ShorterUnchanged
  s := 'AB';
  ASSERT_EQUAL_STRING(s, 'AB');
  ASSERT_EQUAL_INT(LEN(s), 2);
END_METHOD
METHOD Test_ExactLengthUnchanged
  s := 'ABCDE';
  ASSERT_EQUAL_STRING(s, 'ABCDE');
END_METHOD
METHOD Test_ConcatIntoShortTruncates
  t := CONCAT('AB', 'CDEF');
  ASSERT_EQUAL_STRING(t, 'ABC');
END_METHOD
METHOD Test_ConcatWideKeepsAll
  u := CONCAT('AB', 'CDEF');
  ASSERT_EQUAL_STRING(u, 'ABCDEF');
  ASSERT_EQUAL_INT(LEN(u), 6);
END_METHOD
METHOD Test_CopyBetweenStringsTruncates
  u := 'ABCDEFGH';
  t := u;
  ASSERT_EQUAL_STRING(t, 'ABC');
  ASSERT_EQUAL_STRING(u, 'ABCDEFGH');
END_METHOD
METHOD Test_EmptyString
  s := '';
  ASSERT_EQUAL_INT(LEN(s), 0);
END_METHOD
END_FUNCTION_BLOCK
