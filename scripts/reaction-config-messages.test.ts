import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_PATH_PENDING_DRAFT,
  DELIVERY_PATH_SELF_SUBMITTED,
  deriveMessageShape,
} from '../docs/worker-message-dispatch-observe.mjs';
import {
  extractSendToAgentReactionMessages,
  parseReactionMessagesFromYaml,
  parseReactionsSection,
  readReactionMessagesFromYamlFile,
  resolveReactionDeliveryShapeFromYaml,
  validateReactionsSection,
} from './reaction-config-messages.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const exampleYaml = readFileSync(
  path.join(root, '..', 'agent-orchestrator.yaml.example'),
  'utf8',
);

const reportStaleLiveMessage =
  'Worker idle (report-stale backstop). Check pending AO review findings via `ao review list` and report `ao report addressing_reviews`, or report a terminal failure with a reason. Do not stay silent after review findings land.';

describe('reaction-config-messages (Issue #402)', () => {
  it('parses only send-to-agent reactions with non-empty message from example yaml', () => {
    const parsed = parseReactionMessagesFromYaml(exampleYaml);
    expect(parsed.ok).toBe(true);
    expect(parsed.messages?.['report-stale']).toBe(reportStaleLiveMessage);
    expect(parsed.messages?.['ci-failed']).toBeUndefined();
    expect(parsed.messages?.['changes-requested']).toBeUndefined();
  });

  it('excludes notify reactions even when message text is present', () => {
    const reactions = parseReactionsSection(exampleYaml);
    const messages = extractSendToAgentReactionMessages(reactions);
    expect(messages['ci-failed']).toBeUndefined();
  });

  it('AC1: report-stale live text is 224 chars and pending-draft', () => {
    const shape = resolveReactionDeliveryShapeFromYaml(exampleYaml, 'report-stale');
    expect(shape.ok).toBe(true);
    expect(shape.messageShape?.charLength).toBe(224);
    expect(shape.deliveryPath).toBe(DELIVERY_PATH_PENDING_DRAFT);
  });

  it('AC2 threshold boundary: 199/200 self-submitted, 201 pending-draft', () => {
    expect(deriveMessageShape('x'.repeat(199)).deliveryPath).toBe(DELIVERY_PATH_SELF_SUBMITTED);
    expect(deriveMessageShape('x'.repeat(200)).deliveryPath).toBe(DELIVERY_PATH_SELF_SUBMITTED);
    expect(deriveMessageShape('x'.repeat(201)).deliveryPath).toBe(DELIVERY_PATH_PENDING_DRAFT);
  });

  it('AC3: multiline short message is pending-draft', () => {
    expect(deriveMessageShape('line one\nline two').deliveryPath).toBe(
      DELIVERY_PATH_PENDING_DRAFT,
    );
  });

  it('AC5: stale ci-failed stub text must not appear in parsed send-to-agent map', () => {
    const stub = 'Required CI failed for your PR. Fix failing checks and ao report fixing_ci.';
    const parsed = parseReactionMessagesFromYaml(exampleYaml);
    expect(Object.values(parsed.messages ?? {})).not.toContain(stub);
  });

  it('AC7 drift guard: example yaml report-stale shape stays pending-draft', () => {
    const shape = resolveReactionDeliveryShapeFromYaml(exampleYaml, 'report-stale');
    expect(shape.deliveryPath).toBe(DELIVERY_PATH_PENDING_DRAFT);
  });

  it('AC7 live capture token matches example report-stale message text', () => {
    expect(reportStaleLiveMessage).toContain('Worker idle (report-stale backstop)');
  });

  it('readReactionMessagesFromYamlFile fails closed on missing path', () => {
    const result = readReactionMessagesFromYamlFile('/does/not/exist/agent-orchestrator.yaml');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('reaction_config_unavailable');
  });

  it('rejects unsupported flow-style reaction message syntax', () => {
    const yaml = [
      'reactions:',
      '  report-stale:',
      '    action: send-to-agent',
      '    message: [invalid, flow]',
    ].join('\n');
    const result = parseReactionMessagesFromYaml(yaml);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('reaction_config_unavailable');
    expect(result.error).toContain('unsupported_flow_scalar');
  });

  it('rejects send-to-agent message block when scalar body is missing', () => {
    const yaml = [
      'reactions:',
      '  report-stale:',
      '    action: send-to-agent',
      '    message: |',
    ].join('\n');
    const result = parseReactionMessagesFromYaml(yaml);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('reaction_config_unavailable');
  });

  it('accepts quoted inline reaction message scalars', () => {
    const yaml = [
      'reactions:',
      '  report-stale:',
      '    action: send-to-agent',
      '    message: "Worker idle (report-stale backstop)."',
    ].join('\n');
    const result = parseReactionMessagesFromYaml(yaml);
    expect(result.ok).toBe(true);
    expect(result.messages?.['report-stale']).toBe('Worker idle (report-stale backstop).');
  });

  it('allows send-to-agent without message field (runtime unresolved key path)', () => {
    const yaml = [
      'reactions:',
      '  changes-requested:',
      '    action: send-to-agent',
    ].join('\n');
    const validated = validateReactionsSection(yaml);
    expect(validated.ok).toBe(true);
    expect(parseReactionMessagesFromYaml(yaml).messages?.['changes-requested']).toBeUndefined();
  });
});
