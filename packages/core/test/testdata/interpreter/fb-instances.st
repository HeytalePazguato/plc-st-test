(* IEC 61131-3 §6.6.3 (function blocks): every FB instance has its own copy of the internal VAR state, instances do not share data, and state persists between calls of the same instance. Struct assignment (§6.4.4.3) copies all members. *)
TYPE ST_Point : STRUCT x : DINT; y : DINT; END_STRUCT; END_TYPE

FUNCTION_BLOCK FB_Acc
VAR_INPUT step : DINT; END_VAR
VAR total : DINT; END_VAR
VAR_OUTPUT out : DINT; END_VAR
METHOD Add
  total := total + step;
  out := total;
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK TEST_FbInstances
VAR
  a, b : FB_Acc;
  p, q : ST_Point;
  r : DINT;
END_VAR
METHOD Test_InstancesAreIndependent
  a.step := 1; b.step := 10;
  a.Add(); a.Add(); b.Add();
  ASSERT_EQUAL_DINT(a.total, 2);
  ASSERT_EQUAL_DINT(b.total, 10);
END_METHOD
METHOD Test_StatePersistsBetweenCalls
  a.step := 5;
  a.Add(); a.Add(); a.Add();
  ASSERT_EQUAL_DINT(a.out, 15);
END_METHOD
METHOD Test_OutputReadAfterCall
  b.step := 3;
  b.Add();
  r := b.out;
  ASSERT_EQUAL_DINT(r, 3);
END_METHOD
METHOD Test_StructAssignmentCopies
  p.x := 1; p.y := 2;
  q := p;
  p.x := 100;
  ASSERT_EQUAL_DINT(q.x, 1);
  ASSERT_EQUAL_DINT(q.y, 2);
  ASSERT_EQUAL_DINT(p.x, 100);
END_METHOD
METHOD Test_FreshInstanceHasZeroState
  ASSERT_EQUAL_DINT(a.total, 0);
  ASSERT_EQUAL_DINT(p.x, 0);
END_METHOD
END_FUNCTION_BLOCK
