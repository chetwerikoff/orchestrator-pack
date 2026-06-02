import { parseCodexOutput, type ParseCodexOutputResult } from './parse_output.js';
import {
  diagnosticSnippet,
  parseReviewModeFromChannels,
  type ParseReviewOutputResult,
} from './review_jsonl.js';
import type { ReviewSource } from './types.js';

export interface ReviewVerdictChannels {
  processJsonl: string;
  lastMessage: string;
  stderr: string;
  repoRoot: string;
  sessionJsonl?: string | null;
  codexHome?: string;
}

export type SelectReviewVerdictResult = ParseCodexOutputResult & {
  verdictSource: 'review_mode_jsonl' | 'last_message_fallback';
};

function reviewModeToCodexResult(result: ParseReviewOutputResult): ParseCodexOutputResult {
  if (result.kind === 'clean') {
    return { kind: 'clean' };
  }
  if (result.kind === 'findings') {
    return { kind: 'findings', findings: result.findings };
  }
  return { kind: 'error', message: result.message };
}

export function selectReviewVerdict(
  channels: ReviewVerdictChannels & { source: ReviewSource },
): SelectReviewVerdictResult {
  const jsonlResult = parseReviewModeFromChannels({
    processJsonl: channels.processJsonl,
    sessionJsonl: channels.sessionJsonl,
    source: channels.source,
    repoRoot: channels.repoRoot,
    codexHome: channels.codexHome,
  });

  if (jsonlResult) {
    const converted = reviewModeToCodexResult(jsonlResult);
    if (converted.kind === 'error') {
      const snippet = diagnosticSnippet(
        channels.sessionJsonl ??
          channels.processJsonl ??
          channels.lastMessage ??
          channels.stderr,
      );
      return {
        kind: 'error',
        message: `${converted.message} (diagnostic: ${snippet})`,
        verdictSource: 'review_mode_jsonl',
      };
    }
    return {
      ...converted,
      verdictSource: 'review_mode_jsonl',
    };
  }

  const fallback = parseCodexOutput(channels.lastMessage);
  if (fallback.kind === 'error') {
    const snippet = diagnosticSnippet(
      channels.lastMessage || channels.processJsonl || channels.stderr,
    );
    return {
      kind: 'error',
      message: `${fallback.message} (diagnostic: ${snippet})`,
      verdictSource: 'last_message_fallback',
    };
  }

  return {
    ...fallback,
    verdictSource: 'last_message_fallback',
  };
}
