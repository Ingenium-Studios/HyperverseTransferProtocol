#!/usr/bin/env node
import { main } from "./cli.js";

// Set the exit code and return naturally (never process.exit) so piped stdout is flushed completely.
process.exitCode = await main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
