export const PACKAGE_NAME = '@plc-st/plugin-api'

/** Major version of the plugin contracts in this package. A plugin declares the `apiVersion` it was built against; core refuses plugins whose major differs. */
export const PLUGIN_API_VERSION = 1

/** True when a plugin built against `apiVersion` can be loaded by this host (same major version). */
export function isCompatible(apiVersion: number): boolean {
  return Number.isInteger(apiVersion) && apiVersion === PLUGIN_API_VERSION
}
