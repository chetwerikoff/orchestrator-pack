import { randomBytes } from 'node:crypto';

const MARKER_PREFIX = 'OPKTURNV1';
const MARKER_HEX_LENGTH = 32;
const MARKER_PATTERN = new RegExp(`^${MARKER_PREFIX}[0-9a-f]{${MARKER_HEX_LENGTH}}$`);

type RandomSource = (size: number) => Uint8Array;

function isConsumablePrefixScalar(scalar: string): boolean {
  return /^\p{White_Space}$/u.test(scalar) || scalar === '\uFEFF' || scalar === '\u200B';
}

/**
 * Generate one invocation-local marker from one cryptographically strong source call.
 */
export function generateOwnedPromptMarker(source: RandomSource = randomBytes): string {
  const bytes = source(16);
  if (bytes.length !== 16) throw new Error('owned_prompt_marker_source_invalid');
  const marker = `${MARKER_PREFIX}${Buffer.from(bytes).toString('hex')}`;
  if (!MARKER_PATTERN.test(marker)) throw new Error('owned_prompt_marker_invalid');
  return marker;
}

export function wrapOwnedPromptPayload(marker: string, originalPayload: string): string {
  if (!MARKER_PATTERN.test(marker)) throw new Error('owned_prompt_marker_invalid');
  return `${marker}\n\n${originalPayload}`;
}

/**
 * Extract only the first token after the closed consumable-prefix scan.
 */
export function extractOwnedPromptMarkerToken(rawInnerText: string): string {
  const scalars = [...rawInnerText];
  let index = 0;
  while (index < scalars.length && isConsumablePrefixScalar(scalars[index]!)) index += 1;
  const start = index;
  while (index < scalars.length && !isConsumablePrefixScalar(scalars[index]!)) index += 1;
  return scalars.slice(start, index).join('');
}

export function ownedPromptMarkerMatches(rawInnerText: string, expectedMarker: string): boolean {
  return extractOwnedPromptMarkerToken(rawInnerText) === expectedMarker;
}

export function isOwnedPromptMarker(value: string): boolean {
  return MARKER_PATTERN.test(value);
}
