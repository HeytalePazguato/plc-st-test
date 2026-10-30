#!/usr/bin/env node
import { main } from './program.js'

// `exitCode` rather than `process.exit`, so piped stdout is flushed first.
process.exitCode = await main(process.argv.slice(2))
