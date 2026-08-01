import {
  registerWorkerSmokeLifecycleRegressionTests as registerBaseLifecycleRegressionTests,
} from './worker-smoke-lifecycle-regressions-base.ts';
import {
  registerWorkerSmokeControlPlaneRegressionTests,
} from './worker-smoke-control-plane-regressions.ts';

export function registerWorkerSmokeLifecycleRegressionTests(
  input: Parameters<typeof registerBaseLifecycleRegressionTests>[0],
): void {
  registerBaseLifecycleRegressionTests(input);
  registerWorkerSmokeControlPlaneRegressionTests({
    expect: input.expect,
    it: input.it,
  });
}
