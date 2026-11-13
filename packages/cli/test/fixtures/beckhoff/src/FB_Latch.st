{attribute 'reflection'}
FUNCTION_BLOCK FB_Latch
VAR_INPUT
  bSet : BOOL;
  bReset : BOOL;
  nDivisor : INT;
END_VAR
VAR_OUTPUT
  bLatched : BOOL;
  bRatioOk : BOOL;
END_VAR
VAR
  {attribute 'hide'}
  nCalls : INT;
END_VAR
{attribute 'hide'}
nCalls := nCalls + 1;
bLatched S= bSet;
bLatched R= bReset;
bRatioOk := nDivisor <> 0 AND_THEN (100 / nDivisor > 10);
IF nDivisor = 0 OR_ELSE (100 / nDivisor > 50) THEN
  bRatioOk := FALSE;
END_IF
END_FUNCTION_BLOCK
