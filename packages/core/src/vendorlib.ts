/**
 * Recognition of the vendor-side `PlcStTest` library: the TwinCAT and Automation Studio libraries that declare the test host functions (`integrations/vendor-libs/manifest.json`) so the vendor IDE compiles test code. The runner implements those functions itself, so a reference to the library is never auto-stubbed and its source declarations, when ingested, are ignored in favour of the host functions.
 */
import type { LibraryRef } from '@plc-st/project-model'

/** The name of the vendor test library, matched case-insensitively. */
export const VENDOR_TEST_LIB_NAME = 'PlcStTest'

/** True for a reference to the `PlcStTest` library at any version. */
export function isVendorTestLib(ref: LibraryRef): boolean {
  return ref.name.toLowerCase() === VENDOR_TEST_LIB_NAME.toLowerCase()
}

/** True when `name` is the library name `PlcStTest`, as a symbol qualifier such as `PlcStTest.ASSERT_TRUE` writes it. */
export function isVendorTestLibName(name: string): boolean {
  return isVendorTestLib({ name, kind: 'vendor-test-lib' })
}
