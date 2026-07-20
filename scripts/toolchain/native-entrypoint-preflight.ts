import { resolve } from 'node:path';
import { assertNodeRuntimeContract } from './node-runtime-contract.mjs';

export const nativeEntrypointRuntime = assertNodeRuntimeContract(resolve(import.meta.dirname, '../..'));
