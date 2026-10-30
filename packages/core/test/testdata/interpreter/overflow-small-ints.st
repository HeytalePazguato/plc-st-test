(* IEC 61131-3 §6.6.1 / Table 30: integer arithmetic on a fixed-width type wraps modulo 2^N on assignment (two's complement): SINT -128..127, USINT 0..255, INT -32768..32767, UINT 0..65535. *)
FUNCTION_BLOCK TEST_OverflowSmall
VAR s : SINT; us : USINT; i : INT; ui : UINT; END_VAR
METHOD Test_SintPositiveWrap
  s := 127; s := s + 1;
  ASSERT_EQUAL_SINT(s, -128);
END_METHOD
METHOD Test_SintNegativeWrap
  s := -128; s := s - 1;
  ASSERT_EQUAL_SINT(s, 127);
END_METHOD
METHOD Test_UsintWrap
  us := 255; us := us + 1;
  ASSERT_EQUAL_USINT(us, 0);
  us := 0; us := us - 1;
  ASSERT_EQUAL_USINT(us, 255);
END_METHOD
METHOD Test_IntWrap
  i := 32767; i := i + 1;
  ASSERT_EQUAL_INT(i, -32768);
  i := -32768; i := i - 1;
  ASSERT_EQUAL_INT(i, 32767);
END_METHOD
METHOD Test_UintWrap
  ui := 65535; ui := ui + 1;
  ASSERT_EQUAL_UINT(ui, 0);
  ui := 0; ui := ui - 1;
  ASSERT_EQUAL_UINT(ui, 65535);
END_METHOD
METHOD Test_MultiplyWrap
  s := 100; s := s * 2;
  ASSERT_EQUAL_SINT(s, -56);
  us := 200; us := us * 2;
  ASSERT_EQUAL_USINT(us, 144);
END_METHOD
METHOD Test_NegateMinimum
  s := -128; s := -s;
  ASSERT_EQUAL_SINT(s, -128);
END_METHOD
END_FUNCTION_BLOCK
