#!/usr/bin/env node
import {runRecoveryCli} from "../src/recovery-cli.js";

try {
  process.exitCode = await runRecoveryCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`openclaw-room-recovery: ${error.message}\n`);
  process.exitCode = 1;
}
