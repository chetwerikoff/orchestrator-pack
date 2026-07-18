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
  validateReactionsSection,
} from './reaction-config-messages.mjs';

describe('reaction-config message parser', () => {
  it('parses send-to-agent messages from an explicit synthetic fixture', () => {
    const yaml = [
      'reactions:',
      '  report-stale:',
      '    action: send-to-agent',
      '    message: "Worker idle."',
      '  ci-failed:',
      '    action: notify',
      '    message: "Operator notification."',
    ].join('\n');

    const parsed = parseReactionMessagesFromYaml(yaml);
    expect(parsed.ok).toBe(true);
    expect(parsed.messages).toEqual({ 'report-stale': 'Worker idle.' });
  });

  it('excludes notify reactions even when message text is present', () => {
    const yaml = [
      'reactions:',
      '  ci-failed:',
      '    action: notify',
      '    message: "Operator notification."',
    ].join('\n');
    const messages = extractSendToAgentReactionMessages(parseReactionsSection(yaml));
    expect(messages['ci-failed']).toBeUndefined();
  });

  it('keeps the message-shape threshold contract', () => {
    expect(deriveMessageShape('x'.repeat(199)).deliveryPath).toBe(DELIVERY_PATH_SELF_SUBMITTED);
    expect(deriveMessageShape('x'.repeat(200)).deliveryPath).toBe(DELIVERY_PATH_SELF_SUBMITTED);
    expect(deriveMessageShape('x'.repeat(201)).deliveryPath).toBe(DELIVERY_PATH_PENDING_DRAFT);
    expect(deriveMessageShape('line one\nline two').deliveryPath).toBe(DELIVERY_PATH_PENDING_DRAFT);
  });

  it('decodes quoted escapes and folded block scalars', () => {
    const quoted = parseReactionMessagesFromYaml([
      'reactions:',
      '  report-stale:',
      '    action: send-to-agent',
      '    message: "line one\\nline two"',
    ].join('\n'));
    expect(quoted.messages?.['report-stale']).toBe('line one\nline two');

    const folded = parseReactionMessagesFromYaml([
      'reactions:',
      '  report-stale:',
      '    action: send-to-agent',
      '    message: >-',
      '      line one continues',
      '      on the next line',
    ].join('\n'));
    expect(folded.messages?.['report-stale']).toBe('line one continues on the next line');
  });

  it('preserves blank lines in block scalar messages', () => {
    const parsed = parseReactionMessagesFromYaml([
      'reactions:',
      '  report-stale:',
      '    action: send-to-agent',
      '    message: |',
      '      line one',
      '',
      '      line two',
    ].join('\n'));
    expect(parsed.messages?.['report-stale']).toBe('line one\n\nline two');
  });

  it('fails closed for unsupported or unavailable input', () => {
    expect(readReactionMessagesFromYamlFile('/does/not/exist/agent-orchestrator.yaml')).toMatchObject({
      ok: false,
      reason: 'reaction_config_unavailable',
    });

    const unsupported = parseReactionMessagesFromYaml([
      'reactions:',
      '  report-stale:',
      '    action: send-to-agent',
      '    message: [invalid, flow]',
    ].join('\n'));
    expect(unsupported.ok).toBe(false);
    expect(unsupported.reason).toBe('reaction_config_unavailable');
  });

  it('allows a send-to-agent reaction without a message field', () => {
    const yaml = [
      'reactions:',
      '  changes-requested:',
      '    action: send-to-agent',
    ].join('\n');
    expect(validateReactionsSection(yaml).ok).toBe(true);
    expect(parseReactionMessagesFromYaml(yaml).messages?.['changes-requested']).toBeUndefined();
  });
});
