FUNCTION_BLOCK FB_Widget
VAR
  nValue : INT;
  nInitCalls : INT;
  pExited : POINTER TO BOOL;
END_VAR
METHOD FB_init : BOOL
VAR_INPUT
  bInitRetains : BOOL;
  bInCopyCode : BOOL;
  nInitial : INT;
  pFlag : POINTER TO BOOL;
END_VAR
  nValue := nInitial;
  pExited := pFlag;
  nInitCalls := nInitCalls + 1;
  FB_init := TRUE;
END_METHOD
METHOD FB_exit
VAR_INPUT
  bInCopyCode : BOOL;
END_VAR
  IF pExited <> 0 THEN
    pExited^ := TRUE;
  END_IF
END_METHOD
METHOD FB_reinit
  nValue := 0;
END_METHOD
METHOD Bump
  nValue := nValue + 1;
END_METHOD
END_FUNCTION_BLOCK
