export interface CaptureWorkerStateEpisode {
  targetGeneration: string;
}

export interface CaptureWorkerReport {
  reportState: string;
  [key: string]: unknown;
}

export interface CaptureWorkerSession {
  reports: CaptureWorkerReport[];
  [key: string]: unknown;
}

export interface CaptureWorkerState {
  sessions: CaptureWorkerSession[];
  openPrs: Array<Record<string, unknown>>;
}

export declare function buildCaptureWorkerState(
  scenarioFixture: string,
  episode: CaptureWorkerStateEpisode,
  fixtureDir?: string,
): CaptureWorkerState;
