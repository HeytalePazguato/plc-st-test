#!/usr/bin/env node
import { VERSION } from './index.js'

// The full commander-based CLI (run/discover/--output/--watch) is implemented in a later phase. This placeholder keeps the `bin` entry buildable.
console.log(`plc-st-test ${VERSION}`)
