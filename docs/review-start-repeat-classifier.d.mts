export declare const REVIEW_START_REPEAT_CLASSIFIER_VERSION: string;
export declare const CLASSIFIER_INPUT_KEYS: readonly string[];

export declare function classifyReviewStartAttempt(input: Record<string, unknown>): Record<
  string,
  unknown
>;

export declare function classifyReviewStartAttemptSeries(
  attempts: Array<Record<string, unknown>>,
): Array<Record<string, unknown>>;
