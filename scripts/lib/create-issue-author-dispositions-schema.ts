export const AUTHOR_DISPOSITIONS_SCHEMA = 'create-issue-author-dispositions/v1' as const;

export const AUTHOR_FINDING_TYPES = Object.freeze([
  'security',
  'scope-violation',
  'spec',
  'quality',
  'test',
  'ci',
] as const);

export const DEFECT_DISPOSITION_VALUES = Object.freeze([
  'addressed',
  'rejected-as-false',
  'unresolved',
] as const);

export const REMEDY_DISPOSITION_VALUES = Object.freeze([
  'accepted',
  'replaced-by-cheaper-sufficient',
  'rejected-as-overengineering',
] as const);

export const M4_DISPOSITION_VALUES = Object.freeze([
  'keep',
  'simplify',
  'defer',
  'cut',
] as const);

export const AUTHOR_DISPOSITION_FIELD_OWNERSHIP = Object.freeze({
  authorOwnedRequired: Object.freeze([
    'schema',
    'sourceRevision',
    'findings',
    'm4.inventory',
    'findings[].id',
    'findings[].type',
    'findings[].occurrences',
    'findings[].defectDisposition',
    'findings[].remedyDisposition',
  ]),
  authorOwnedConditional: Object.freeze([
    'findings[].rejectReason when defectDisposition=rejected-as-false',
    'findings[].proposalReason when remedyDisposition!=accepted',
  ]),
  authorOwnedOptional: Object.freeze([
    'findings[].reason',
    'findings[].persistent-machinery',
    'findings[].simplificationCutCandidate',
    'findings[].architectPending',
    'findings[].architectRequired',
    'findings[].protectedActivation',
    'findings[].protectedOccurrences',
    'm4.inventory[].mechanism',
    'm4.inventory[].disposition',
  ]),
  lifecycleInjected: Object.freeze([
    'reviewEpisodeId',
    'predecessorStage',
    'tier',
    'stageAttemptId',
    'invocation',
    'terminalResultIdentity',
    'reviewerSource',
    'reviewerSlot',
    'reviewerTerminalState',
    'reviewLane',
    'captureIdentity',
    'relayEligibleCaptures',
    'credentialing',
    'draft',
    'issueNumber',
    'issueTitle',
  ]),
});

export type AuthorDispositionDiagnosticReason =
  | 'missing_schema_label'
  | 'malformed_json'
  | 'invalid_author_field';

export type AuthorDispositionOwnership = 'author-owned' | 'lifecycle-injected' | 'unclassified';

export interface AuthorDispositionDiagnostic {
  reason: AuthorDispositionDiagnosticReason;
  ownership: 'author-owned';
  field: string;
  message: string;
}

export interface ParsedGovernedAuthorDisposition {
  value: Record<string, unknown>;
  diagnostics: AuthorDispositionDiagnostic[];
  schemaFragment: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const OCCURRENCE_ID_RE = /^sha256:[a-f0-9]{64}:[^:\n]+:[1-9][0-9]*$/i;

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => nonEmptyString(entry))
    && new Set(value).size === value.length;
}

function fieldToken(field: string): string {
  return field
    .replace(/\[\]/g, '')
    .replace(/\[[0-9]+\]/g, '')
    .split(/[ .]/)[0]!
    .trim();
}

export function authorDispositionFieldOwnership(field: string): AuthorDispositionOwnership {
  const token = fieldToken(field);
  const authorFields = [
    ...AUTHOR_DISPOSITION_FIELD_OWNERSHIP.authorOwnedRequired,
    ...AUTHOR_DISPOSITION_FIELD_OWNERSHIP.authorOwnedConditional,
    ...AUTHOR_DISPOSITION_FIELD_OWNERSHIP.authorOwnedOptional,
  ].map(fieldToken);
  if (authorFields.some((candidate) => token === candidate || token.startsWith(candidate + '.'))) {
    return 'author-owned';
  }
  const lifecycleFields = AUTHOR_DISPOSITION_FIELD_OWNERSHIP.lifecycleInjected.map(fieldToken);
  if (lifecycleFields.some((candidate) => token === candidate || token.startsWith(candidate + '.'))) {
    return 'lifecycle-injected';
  }
  return 'unclassified';
}

export function classifyAuthorDispositionFailure(message: string): AuthorDispositionOwnership {
  const normalized = message.toLowerCase();
  const occurrenceLedgerFailure = /(?:references unknown occurrence|occurrence .+ maps more than once|occurrence .+ is not mapped exactly once|ledger row .+ has no mapped occurrence)/i.test(normalized);
  if (occurrenceLedgerFailure) return 'author-owned';

  const governedCaptureIntegrityFailure = /^review-economics:\s*(?:supplied capture text count must equal governedcaptureunion|supplied capture .+ is not governed|governed capture .+ supplied more than once|capture .+ (?:name|bytelength|sha256|rawfindingcount) mismatch|governed capture .+ has no supplied immutable text)/i.test(normalized);
  if (governedCaptureIntegrityFailure) return 'lifecycle-injected';

  if (
    normalized.includes('omitted required occurrence')
    || normalized.includes('duplicate occurrence')
    || normalized.includes('occurrence identities')
    || normalized.includes('proposalreason')
    || normalized.includes('proposal reason')
    || normalized.includes('rejectreason')
    || normalized.includes('reject reason')
    || normalized.includes('remedydisposition')
    || normalized.includes('remedy disposition')
    || normalized.includes('defectdisposition')
    || normalized.includes('defect disposition')
    || normalized.includes('m4.inventory')
  ) {
    return 'author-owned';
  }
  for (const field of AUTHOR_DISPOSITION_FIELD_OWNERSHIP.lifecycleInjected) {
    const token = fieldToken(field).toLowerCase();
    if (token && normalized.includes(token)) return 'lifecycle-injected';
  }
  if (normalized.includes('terminalresultidentity')
    || normalized.includes('stageattemptid')
    || normalized.includes('reviewer source')
    || normalized.includes('reviewer slot')
    || normalized.includes('review lane')
    || normalized.includes('capture identity')
    || normalized.includes('relayeligiblecaptures')
    || normalized.includes('credentialing')
    || normalized.includes('review episode tier')
    || normalized.includes('predecessorstage')) {
    return 'lifecycle-injected';
  }
  if (normalized.includes('authority=author-owned')
    || normalized.includes('governed author')
    || normalized.includes('missing_schema_label')
    || normalized.includes('malformed_json')) {
    return 'author-owned';
  }
  for (const field of [
    ...AUTHOR_DISPOSITION_FIELD_OWNERSHIP.authorOwnedRequired,
    ...AUTHOR_DISPOSITION_FIELD_OWNERSHIP.authorOwnedConditional,
    ...AUTHOR_DISPOSITION_FIELD_OWNERSHIP.authorOwnedOptional,
  ]) {
    const token = fieldToken(field).toLowerCase();
    if (token && normalized.includes(token)) return 'author-owned';
  }
  return 'unclassified';
}

export function authorDispositionDiagnosticFromFailure(
  message: string,
): AuthorDispositionDiagnostic | null {
  if (classifyAuthorDispositionFailure(message) !== 'author-owned') return null;
  const normalized = message.toLowerCase();
  let field = '$';
  let reason: AuthorDispositionDiagnosticReason = 'invalid_author_field';
  if (normalized.includes('missing_schema_label') || normalized.includes('schema label')) {
    field = 'schema-label';
    reason = 'missing_schema_label';
  } else if (normalized.includes('proposalreason') || normalized.includes('proposal reason')) {
    field = 'findings[].proposalReason';
  } else if (normalized.includes('rejectreason') || normalized.includes('reject reason')) {
    field = 'findings[].rejectReason';
  } else if (normalized.includes('occurrence')
    || normalized.includes('capture mapping')
    || normalized.includes('capture identity')
    || normalized.includes('omitted required')
    || normalized.includes('duplicate')) {
    field = 'findings[].occurrences';
  } else if (normalized.includes('remedydisposition') || normalized.includes('remedy disposition')) {
    field = 'findings[].remedyDisposition';
  } else if (normalized.includes('defectdisposition') || normalized.includes('defect disposition')) {
    field = 'findings[].defectDisposition';
  } else if (normalized.includes('m4') || normalized.includes('inventory')) {
    field = 'm4.inventory';
  } else if (normalized.includes('finding')) {
    field = 'findings';
  }
  return diagnostic(reason, field, message);
}

function diagnostic(
  reason: AuthorDispositionDiagnosticReason,
  field: string,
  message: string,
): AuthorDispositionDiagnostic {
  return { reason, ownership: 'author-owned', field, message };
}

export function locateGovernedAuthorDispositionBlock(
  text: string,
): { body: string } | { error: 'multiple' | 'none' } {
  const startPattern = /^(?:```)?create-issue-author-dispositions\/v1\s*$/gm;
  const starts = [...text.matchAll(startPattern)];
  if (starts.length !== 1) {
    return { error: starts.length === 0 ? 'none' : 'multiple' };
  }
  const start = starts[0]!;
  let offset = start.index! + start[0].length;
  if (text.startsWith('\r\n', offset)) offset += 2;
  else if (text.startsWith('\n', offset) || text.startsWith('\r', offset)) offset += 1;
  const rest = text.slice(offset);
  const close = /^```[ \t]*$/m.exec(rest);
  return { body: (close ? rest.slice(0, close.index) : rest).trim() };
}

function validateFinding(
  finding: Record<string, unknown>,
  index: number,
  diagnostics: AuthorDispositionDiagnostic[],
): void {
  const base = `findings[${index}]`;
  if (!nonEmptyString(finding.id)) {
    diagnostics.push(diagnostic('invalid_author_field', `${base}.id`, `${base}.id must be a non-empty string`));
  }
  if (!AUTHOR_FINDING_TYPES.includes(finding.type as typeof AUTHOR_FINDING_TYPES[number])) {
    diagnostics.push(diagnostic(
      'invalid_author_field',
      `${base}.type`,
      `${base}.type must be one of ${AUTHOR_FINDING_TYPES.join('|')}`,
    ));
  }
  if (!stringArray(finding.occurrences)) {
    diagnostics.push(diagnostic(
      'invalid_author_field',
      `${base}.occurrences`,
      `${base}.occurrences must be a non-empty unique string array`,
    ));
  } else if (finding.occurrences.some((entry) => !OCCURRENCE_ID_RE.test(entry))) {
    diagnostics.push(diagnostic(
      'invalid_author_field',
      `${base}.occurrences`,
      `${base}.occurrences must use sha256:<digest>:<capture-filename>:<ordinal> identities`,
    ));
  }
  if (!DEFECT_DISPOSITION_VALUES.includes(
    finding.defectDisposition as typeof DEFECT_DISPOSITION_VALUES[number],
  )) {
    diagnostics.push(diagnostic(
      'invalid_author_field',
      `${base}.defectDisposition`,
      `${base}.defectDisposition must be one of ${DEFECT_DISPOSITION_VALUES.join('|')}`,
    ));
  }
  if (!REMEDY_DISPOSITION_VALUES.includes(
    finding.remedyDisposition as typeof REMEDY_DISPOSITION_VALUES[number],
  )) {
    diagnostics.push(diagnostic(
      'invalid_author_field',
      `${base}.remedyDisposition`,
      `${base}.remedyDisposition must be one of ${REMEDY_DISPOSITION_VALUES.join('|')}`,
    ));
  }
  if (finding.defectDisposition === 'rejected-as-false' && !nonEmptyString(finding.rejectReason)) {
    diagnostics.push(diagnostic(
      'invalid_author_field',
      `${base}.rejectReason`,
      `${base}.rejectReason is required when defectDisposition=rejected-as-false`,
    ));
  }
  if (finding.remedyDisposition !== undefined
    && finding.remedyDisposition !== 'accepted'
    && !nonEmptyString(finding.proposalReason)) {
    diagnostics.push(diagnostic(
      'invalid_author_field',
      `${base}.proposalReason`,
      `${base}.proposalReason is required when remedyDisposition is not accepted`,
    ));
  }
  for (const booleanField of ['architectPending', 'architectRequired', 'simplificationCutCandidate'] as const) {
    if (finding[booleanField] !== undefined && typeof finding[booleanField] !== 'boolean') {
      diagnostics.push(diagnostic(
        'invalid_author_field',
        `${base}.${booleanField}`,
        `${base}.${booleanField} must be boolean when present`,
      ));
    }
  }
  if (finding.protectedActivation !== undefined && !isRecord(finding.protectedActivation)) {
    diagnostics.push(diagnostic(
      'invalid_author_field',
      `${base}.protectedActivation`,
      `${base}.protectedActivation must be an object when present`,
    ));
  }
  if (finding.protectedOccurrences !== undefined && !Array.isArray(finding.protectedOccurrences)) {
    diagnostics.push(diagnostic(
      'invalid_author_field',
      `${base}.protectedOccurrences`,
      `${base}.protectedOccurrences must be an array when present`,
    ));
  }
}

export function validateGovernedAuthorDispositionValue(
  value: unknown,
): AuthorDispositionDiagnostic[] {
  const diagnostics: AuthorDispositionDiagnostic[] = [];
  if (!isRecord(value)) {
    return [diagnostic('invalid_author_field', '$', 'author disposition payload must be a JSON object')];
  }
  if (value.schema !== AUTHOR_DISPOSITIONS_SCHEMA) {
    diagnostics.push(diagnostic(
      'invalid_author_field',
      'schema',
      `schema must equal ${AUTHOR_DISPOSITIONS_SCHEMA}`,
    ));
  }
  if (!nonEmptyString(value.sourceRevision) || !/^r[0-9]+$/i.test(value.sourceRevision)) {
    diagnostics.push(diagnostic(
      'invalid_author_field',
      'sourceRevision',
      'sourceRevision must be an rNN revision binding',
    ));
  }
  if (!Array.isArray(value.findings)) {
    diagnostics.push(diagnostic('invalid_author_field', 'findings', 'findings must be an array'));
  } else {
    value.findings.forEach((finding, index) => {
      if (!isRecord(finding)) {
        diagnostics.push(diagnostic(
          'invalid_author_field',
          `findings[${index}]`,
          `findings[${index}] must be an object`,
        ));
      } else {
        validateFinding(finding, index, diagnostics);
      }
    });
  }
  if (!isRecord(value.m4) || !Array.isArray(value.m4.inventory)) {
    diagnostics.push(diagnostic(
      'invalid_author_field',
      'm4.inventory',
      'm4.inventory must be an array',
    ));
  } else {
    value.m4.inventory.forEach((item, index) => {
      if (!isRecord(item)) {
        diagnostics.push(diagnostic(
          'invalid_author_field',
          `m4.inventory[${index}]`,
          `m4.inventory[${index}] must be an object`,
        ));
        return;
      }
      if (!nonEmptyString(item.mechanism)) {
        diagnostics.push(diagnostic(
          'invalid_author_field',
          `m4.inventory[${index}].mechanism`,
          `m4.inventory[${index}].mechanism must be a non-empty string`,
        ));
      }
      if (!M4_DISPOSITION_VALUES.includes(item.disposition as typeof M4_DISPOSITION_VALUES[number])) {
        diagnostics.push(diagnostic(
          'invalid_author_field',
          `m4.inventory[${index}].disposition`,
          `m4.inventory[${index}].disposition must be one of ${M4_DISPOSITION_VALUES.join('|')}`,
        ));
      }
    });
  }
  return diagnostics;
}

export function renderAuthorDispositionPromptFragment(): string {
  return [
    'The governed author reply MUST contain exactly one whole-line schema label:',
    AUTHOR_DISPOSITIONS_SCHEMA,
    'The Markdown fence is optional; an in-object "schema" key does not replace the label.',
    'Author-owned payload requirements:',
    '- schema: create-issue-author-dispositions/v1',
    '- sourceRevision: rNN',
    '- findings: array; each row requires id, type, occurrences, defectDisposition, remedyDisposition',
    '- occurrences must enumerate the governed canonical capture occurrences exactly as sha256:<digest>:<capture-filename>:<ordinal>; do not omit, duplicate, or invent occurrence identities',
    `- finding type: ${AUTHOR_FINDING_TYPES.join('|')}`,
    `- defectDisposition: ${DEFECT_DISPOSITION_VALUES.join('|')}`,
    `- remedyDisposition: ${REMEDY_DISPOSITION_VALUES.join('|')}`,
    '- rejectReason is required for defectDisposition=rejected-as-false',
    '- proposalReason is required when remedyDisposition is not accepted',
    '- optional M3 fields architectPending, architectRequired, protectedActivation, protectedOccurrences, and simplificationCutCandidate remain author-owned when applicable',
    '- m4.inventory: array; every row requires mechanism and disposition=keep|simplify|defer|cut',
    'Do not add producer/lifecycle-injected fields; the lifecycle producer supplies them separately.',
  ].join('\n');
}

export function parseGovernedAuthorDispositionText(
  text: string,
): ParsedGovernedAuthorDisposition {
  const schemaFragment = renderAuthorDispositionPromptFragment();
  const located = locateGovernedAuthorDispositionBlock(text);
  if ('error' in located) {
    const reason = located.error === 'none' ? 'missing_schema_label' : 'invalid_author_field';
    const message = located.error === 'none'
      ? `missing whole-line ${AUTHOR_DISPOSITIONS_SCHEMA} schema label`
      : `author reply must contain exactly one whole-line ${AUTHOR_DISPOSITIONS_SCHEMA} schema label`;
    return {
      value: {},
      diagnostics: [diagnostic(reason, 'schema-label', message)],
      schemaFragment,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(located.body) as unknown;
  } catch {
    return {
      value: {},
      diagnostics: [diagnostic('malformed_json', '$', 'governed author disposition block is malformed JSON')],
      schemaFragment,
    };
  }
  return {
    value: isRecord(parsed) ? parsed : {},
    diagnostics: validateGovernedAuthorDispositionValue(parsed),
    schemaFragment,
  };
}

export function authorDispositionDiagnosticsText(
  diagnostics: readonly AuthorDispositionDiagnostic[],
): string {
  return diagnostics.map((item) => `${item.reason}:${item.field}: ${item.message}`).join('\n');
}
