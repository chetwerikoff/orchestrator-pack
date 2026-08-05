import {
  registerWorkerSmokeCleanupClockRegressionTests,
} from './worker-smoke-cleanup-clock-regressions.ts';
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
  registerWorkerSmokeCleanupClockRegressionTests({
    expect: input.expect,
    it: input.it,
    vi: input.vi,
  });
  registerWorkerSmokeControlPlaneRegressionTests({
    expect: input.expect,
    it: input.it,
  });
}
