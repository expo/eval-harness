#!/usr/bin/env bun
import { runCli } from '../build/main.js';

process.exitCode = await runCli(process.argv.slice(2));
