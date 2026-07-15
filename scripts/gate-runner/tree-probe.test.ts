import { execFileSync } from 'node:child_process';

throw new Error(`REBASING_TREE=${execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()}`);
