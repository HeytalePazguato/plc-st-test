(* IEC 61131-3 §6.6.1 / Table 30: DINT (-2^31..2^31-1) and UDINT (0..2^32-1) arithmetic wraps modulo 2^32. *)
FUNCTION_BLOCK TEST_OverflowDint
VAR d : DINT; ud : UDINT; END_VAR
METHOD Test_DintPositiveWrap
  d := 2147483647; d := d + 1;
  ASSERT_EQUAL_DINT(d, -2147483648);
END_METHOD
METHOD Test_DintNegativeWrap
  d := -2147483648; d := d - 1;
  ASSERT_EQUAL_DINT(d, 2147483647);
END_METHOD
METHOD Test_UdintWrap
  ud := 4294967295; ud := ud + 1;
  ASSERT_EQUAL_UDINT(ud, 0);
  ud := 0; ud := ud - 1;
  ASSERT_EQUAL_UDINT(ud, 4294967295);
END_METHOD
METHOD Test_DintMultiplyWrap
  d := 65536; d := d * 65536;
  ASSERT_EQUAL_DINT(d, 0);
  d := 65537; d := d * 65537;
  ASSERT_EQUAL_DINT(d, 131073);
END_METHOD
METHOD Test_UdintMultiplyWrap
  ud := 4294967295; ud := ud * 2;
  ASSERT_EQUAL_UDINT(ud, 4294967294);
END_METHOD
END_FUNCTION_BLOCK
