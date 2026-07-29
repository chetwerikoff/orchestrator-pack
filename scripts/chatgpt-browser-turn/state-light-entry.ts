#!/usr/bin/env node
import { runStateLightTurn } from './state-light-turn.ts';

process.exitCode = await runStateLightTurn(process.argv.slice(2));
