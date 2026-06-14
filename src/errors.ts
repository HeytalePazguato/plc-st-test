/**
 * Shared runtime error classes for the IEC 61131-3 interpreter.
 *
 * Kept intentionally minimal: this is the stable home that sibling tasks
 * import from. Additional subclasses (e.g. IecTimeoutError) are added later.
 */

/** Base class for all errors raised by this package. */
export class IecError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'IecError'
  }
}

/** Error raised while executing/evaluating IEC code (e.g. division by zero). */
export class IecRuntimeError extends IecError {
  constructor(message?: string) {
    super(message)
    this.name = 'IecRuntimeError'
  }
}
