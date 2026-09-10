#!/usr/bin/env bun
import { runCli } from './main.ts';

// Keep execution in a dedicated entrypoint: shared chunks are never import.meta.main.
process.exitCode = await runCli(process.argv.slice(2));
