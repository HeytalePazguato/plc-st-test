FUNCTION_BLOCK TEST_Hostile
VAR
  uut : FB_Dummy;
END_VAR
METHOD Test_CdataEnd
  ASSERT_TRUE(FALSE, 'a ]]> b <![CDATA[ c <script>alert(1)</script> d');
END_METHOD
METHOD Test_TableBreakers
  ASSERT_TRUE(FALSE, 'x | y | `code` & <b>bold</b> "q" $'s$' $N next line | |');
END_METHOD
METHOD Test_ControlChars
  ASSERT_TRUE(FALSE, 'ctl$01$02$07$0B$1F end $00 nul');
END_METHOD
END_FUNCTION_BLOCK
