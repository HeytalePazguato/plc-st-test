/**
 * TwinCAT function block lifecycle on top of the core's instance hooks.
 *
 * - `onInstantiate` calls `FB_init(bInitRetains := FALSE, bInCopyCode := FALSE, <extra inputs>)` on a new instance whose function block declares `FB_init` (also inherited), nested instances first. The extra inputs come from the instance declaration (`fb : FB_X(nParam := 5)`), which the grammar exposes as `init_arguments` and core evaluates and hands to the hook; they must be named, because FB_init's two implicit inputs come first. Arguments on a type without `FB_init` are reported as a warning and ignored.
 * - `onDispose` calls `FB_exit(bInCopyCode := FALSE)` when the function block declares it, children before their parent, once per instance, at the end of every test and on `__DELETE`.
 * - `FB_REINIT('path')` calls `FB_reinit` on the live instance at the dotted variable path.
 */

import type { CallArg, DialectHooks, HostFnDef, IecValue } from '@plc-st/plugin-api'

const FALSE: IecValue = { kind: 'scalar', type: 'BOOL', value: false }

export const onInstantiate: NonNullable<DialectHooks['onInstantiate']> = (inst, ctx, initArgs) => {
  if (!inst.hasMethod('FB_init')) {
    if (initArgs.length > 0) ctx.warn('FB_INIT_MISSING', `'${inst.typeName}' is declared with initialisation arguments but has no FB_init method; the arguments are ignored`)
    return
  }
  if (initArgs.some((a) => a.name === undefined)) throw ctx.error(`initialisation arguments of '${inst.typeName}' must be named (name := value), because FB_init's implicit inputs come first`)
  const args: CallArg[] = [{ name: 'bInitRetains', value: FALSE }, { name: 'bInCopyCode', value: FALSE }, ...initArgs]
  inst.callMethod('FB_init', args)
}

export const onDispose: NonNullable<DialectHooks['onDispose']> = (inst) => {
  if (inst.hasMethod('FB_exit')) inst.callMethod('FB_exit', [{ name: 'bInCopyCode', value: FALSE }])
}

export const fbReinitHostFn: HostFnDef = {
  name: 'FB_REINIT',
  minArgs: 1,
  maxArgs: 1,
  call: (args, ctx) => {
    const path = args[0]!.value
    if (path.kind !== 'scalar' || path.type !== 'STRING') throw ctx.error('FB_REINIT takes the variable path of a function block instance as a STRING')
    const inst = ctx.instanceAt(String(path.value))
    if (inst === undefined) throw ctx.error(`FB_REINIT: '${String(path.value)}' is not a function block instance`)
    if (!inst.hasMethod('FB_reinit')) throw ctx.error(`FB_REINIT: '${inst.typeName}' declares no FB_reinit method`)
    inst.callMethod('FB_reinit', [])
    return undefined
  },
}
