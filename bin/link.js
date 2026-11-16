#!/usr/bin/env node
import {runLinkCli} from "../src/link-cli.js";

process.exitCode = await runLinkCli(process.argv.slice(2));
