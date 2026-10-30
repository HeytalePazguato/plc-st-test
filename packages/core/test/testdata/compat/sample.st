FUNCTION_BLOCK FB_Sample
VAR_INPUT
  bEnable : BOOL;
  nMode : INT;
END_VAR
VAR
  nCount : INT;
  i : INT;
END_VAR

METHOD Step : INT
VAR_INPUT
  nDelta : INT;
END_VAR
  nCount := nCount + nDelta;
  Step := nCount;
END_METHOD

IF bEnable THEN
  nCount := nCount + 1;
ELSE
  nCount := 0;
END_IF;

CASE nMode OF
  0: nCount := 0;
  1, 2: nCount := 10;
ELSE
  nCount := -1;
END_CASE;

FOR i := 0 TO 9 DO
  nCount := nCount + i;
END_FOR;
END_FUNCTION_BLOCK
