export function extractAuthoritativeContractEvidenceBody(markdown: string): string | null;

export function parseContractEvidenceRows(body: string): {
  none: boolean;
  rows: Array<Record<string, string>>;
  malformed: boolean;
};

export function canonicalProducer(producer: string): string;

export function canonicalBindingIdentity(
  row: Record<string, string>,
  kind: 'structured' | 'unstructured',
): string;

export function parseProducerEmissionBlocks(markdown: string): Array<Record<string, string>>;

export function criterionHasProducerEmission(
  markdown: string,
  criterionNumber: number,
): boolean;

export function extractRowProducerEmissionExpectation(
  row: Record<string, string>,
): {
  producer: string;
  datum: string;
  expected: string;
};

export function producerEmissionMatchesRow(
  block: Record<string, string>,
  row: Record<string, string>,
): boolean;

export function producerEmissionHasExecutableProof(block: Record<string, string>): boolean;

export function producerEmissionIsComplete(block: Record<string, string>): boolean;

export function criterionHasMatchingProducerEmission(
  markdown: string,
  criterionNumber: number,
  row: Record<string, string>,
): boolean;

export function isCliBehaviorBinding(row: Record<string, string>): boolean;

export const PRODUCTION_CAPTURE_CORPUS_ROOT: string;

export function acceptanceCriteriaRegion(markdown: string): string | null;

export function acceptanceCriterionSection(
  markdown: string,
  criterionNumber: number,
): string | null;

export function checkContractEvidence(
  markdown: string,
  options?: {
    repoRoot?: string;
    manifestPath?: string;
    legacyListPath?: string;
    draftPath?: string;
  },
): {
  ok: boolean;
  errors: string[];
  skipped: boolean;
};

export function verifyCaptureManifestIntegrity(
  repoRoot: string,
  manifestPath: string,
): {
  ok: boolean;
  errors: string[];
};
