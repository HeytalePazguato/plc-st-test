/**
 * Shared runtime error classes for the IEC 61131-3 interpreter.
 *
 * Kept intentionally minimal: this is the stable home that sibling tasks
 * import from.
 */

import type { OriginalLocation } from '@plc-st/project-model'

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

/** Raised when a resource limit (allocation, wall time, cycle budget) is exceeded. */
export class IecLimitError extends IecError {
  constructor(message?: string) {
    super(message)
    this.name = 'IecLimitError'
  }
}

/** Raised when `RUN_UNTIL` exceeds its max-cycles budget without the condition becoming TRUE. */
export class IecTimeoutError extends IecError {
  constructor(message?: string) {
    super(message)
    this.name = 'IecTimeoutError'
  }
}

/** Raised by an `ASSERT_*` host function; `expected` and `actual` are display strings (see `formatValue`) and `location` is the original file position of the assertion call. */
export class AssertionFailure extends IecError {
  readonly expected: string
  readonly actual: string
  readonly location: OriginalLocation

  constructor(message: string, expected: string, actual: string, location: OriginalLocation) {
    super(message)
    this.name = 'AssertionFailure'
    this.expected = expected
    this.actual = actual
    this.location = location
  }
}
