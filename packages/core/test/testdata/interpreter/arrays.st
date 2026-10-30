(* IEC 61131-3 §6.4.4.4 / Table 15 (ARRAY): bounds are declared as [lo..hi] and may be negative or non-zero based; an element outside the declared bounds is a runtime error; arrays have value semantics on assignment (a copy, not an alias); multi-dimensional arrays index per dimension. *)
FUNCTION_BLOCK TEST_Arrays
VAR
  a : ARRAY[1..5] OF DINT;
  neg : ARRAY[-2..2] OF INT;
  m : ARRAY[0..1, 0..2] OF DINT;
  b : ARRAY[1..5] OF DINT;
  i, idx : DINT;
END_VAR
METHOD Test_FirstAndLastElement
  a[1] := 10;
  a[5] := 50;
  ASSERT_EQUAL_DINT(a[1], 10);
  ASSERT_EQUAL_DINT(a[5], 50);
  ASSERT_EQUAL_DINT(a[3], 0);
END_METHOD
METHOD Test_NegativeLowerBound
  neg[-2] := -20;
  neg[0] := 5;
  neg[2] := 22;
  ASSERT_EQUAL_INT(neg[-2], -20);
  ASSERT_EQUAL_INT(neg[0], 5);
  ASSERT_EQUAL_INT(neg[2], 22);
END_METHOD
METHOD Test_IndexBelowLowerBoundErrors
  idx := 0;
  a[idx] := 1;
END_METHOD
METHOD Test_IndexAboveUpperBoundErrors
  idx := 6;
  i := a[idx];
END_METHOD
METHOD Test_TwoDimensional
  FOR i := 0 TO 2 DO
    m[0, i] := i;
    m[1, i] := 10 + i;
  END_FOR
  ASSERT_EQUAL_DINT(m[0, 2], 2);
  ASSERT_EQUAL_DINT(m[1, 0], 10);
  ASSERT_EQUAL_DINT(m[1, 2], 12);
END_METHOD
METHOD Test_AssignmentCopiesValue
  a[1] := 1; a[2] := 2;
  b := a;
  a[1] := 99;
  ASSERT_EQUAL_DINT(b[1], 1);
  ASSERT_EQUAL_DINT(b[2], 2);
  ASSERT_EQUAL_DINT(a[1], 99);
END_METHOD
METHOD Test_ComputedIndex
  FOR i := 1 TO 5 DO
    a[i] := i * i;
  END_FOR
  ASSERT_EQUAL_DINT(a[a[2]], 16);
END_METHOD
END_FUNCTION_BLOCK
