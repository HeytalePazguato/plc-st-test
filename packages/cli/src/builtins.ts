/**
 * What the published CLI ships with, imported statically so it works with zero plugins installed.
 *
 * Only the packages with a default `PluginModule` are listed. `@plc-st/ingestor-beckhoff`, `@plc-st/ingestor-br`, `@plc-st/dialect-beckhoff` and `@plc-st/dialect-br` are still empty; each is added to `BUILTIN_MODULES` when it gains one.
 */

import { githubReporter, jsonReporter, junitReporter, tapReporter, terminalReporter } from '@plc-st/core'
import standardDialect from '@plc-st/dialect-standard'
import genericIngestor from '@plc-st/ingestor-generic'
import { PLUGIN_API_VERSION } from '@plc-st/plugin-api'
import type { PluginModule } from '@plc-st/plugin-api'

const reporters: PluginModule = { apiVersion: PLUGIN_API_VERSION, reporters: [terminalReporter, junitReporter, jsonReporter, tapReporter, githubReporter] }

/** Registered before the configured plugins, so a plugin can replace a built-in by reusing its id. */
export const BUILTIN_MODULES: readonly PluginModule[] = [genericIngestor, standardDialect, reporters]
