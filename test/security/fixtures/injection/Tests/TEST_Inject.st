FUNCTION_BLOCK TEST_Inject
VAR
  uut : FB_Dummy;
END_VAR
METHOD Test_RawNewlines
  ASSERT_TRUE(FALSE, 'before$N::add-mask::x$N::stop-commands::y$N::error::z');
END_METHOD
METHOD Test_EncodedNewlines
  ASSERT_TRUE(FALSE, '%0A::add-mask::x%0D%0A::stop-commands::y%0A::error::z%25');
END_METHOD
METHOD Test_CarriageReturnAndProperty
  ASSERT_TRUE(FALSE, 'cr$R::set-output name=a::b$R$N::warning file=a,line=1::c');
END_METHOD
END_FUNCTION_BLOCK
