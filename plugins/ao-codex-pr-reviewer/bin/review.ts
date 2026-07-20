#!/usr/bin/env -S node --experimental-strip-types

import '../../../scripts/toolchain/native-entrypoint-preflight.ts';
import { runReviewCli } from '../lib/review_cli.ts';

runReviewCli(process.argv.slice(2));
