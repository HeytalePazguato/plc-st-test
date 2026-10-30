FUNCTION_BLOCK FB_Helper
  VAR_INPUT
    enable : BOOL;
  END_VAR
  VAR_OUTPUT
    done : BOOL;
  END_VAR
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Main
  VAR_INPUT
    pt : TPoint;
  END_VAR
  VAR
    helper : FB_Helper;
    pick : EColor;
  END_VAR
  VAR_TEMP
    scratch : INT;
  END_VAR
  METHOD Step : INT
    VAR_INPUT
      delta : INT;
    END_VAR
    Step := delta;
  END_METHOD
  helper(enable := TRUE);
END_FUNCTION_BLOCK
