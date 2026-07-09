import { afterEach } from 'vitest';
import { touchLeaseProgress } from './testmode-fleet-harness.js';

afterEach(() => {
  touchLeaseProgress();
});
