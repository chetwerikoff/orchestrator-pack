import {
  registerWorkerSmokeLifecycleRegressionTests as registerBaseLifecycleRegressionTests,
} from './worker-smoke-lifecycle-regressions-base.ts';
import {
  registerWorkerSmokeControlPlaneRegressionTests,
} from './worker-smoke-control-plane-regressions.ts';
import { registerRuntimeContractCases } from '../runtime/runtime-contract-cases.ts';
import { registerOrcaAdapterCases } from '../orca-runtime/orca-adapter-cases.ts';

export function registerWorkerSmokeLifecycleRegressionTests(
  input: Parameters<typeof registerBaseLifecycleRegressionTests>[0],
): void {
  registerBaseLifecycleRegressionTests(input);
  registerWorkerSmokeControlPlaneRegressionTests({
    expect: input.expect,
    it: input.it,
  });
  registerRuntimeContractCases({
    describe: input.describe,
    expect: input.expect,
    it: input.it,
  });
  registerOrcaAdapterCases({
    describe: input.describe,
    expect: input.expect,
    it: input.it,
  });
}
