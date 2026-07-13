import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { managedChildRoles as survivors } from './supervisor-recovery.test-helpers.js';

const repoRoot = join(import.meta.dirname, '..');
const scripts = join(repoRoot, 'scripts');

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function json(path: string): any {
  return JSON.parse(read(path));
}

describe('Issue #745 PR-B retirement contract', () => {
  it('retires listener at the registry and entrypoint boundaries', () => {
    const registry = json('scripts/orchestrator-side-process-registry.json');
    const required = registry.requiredChildIds as string[];
    const children = registry.children.map((child: { id: string }) => child.id) as string[];
    expect(required).toHaveLength(survivors.length);
    expect(children).toHaveLength(survivors.length);
    expect(new Set(required)).toEqual(new Set(survivors));
    expect(new Set(children)).toEqual(new Set(survivors));
    expect(JSON.stringify(registry)).not.toContain('listener');
    expect(JSON.stringify(registry)).not.toContain('orchestrator-wake-listener.ps1');
    expect(JSON.stringify(registry)).not.toContain('listener-side-effect.lock');
    expect(existsSync(join(scripts, 'orchestrator-wake-listener.ps1'))).toBe(false);
  });

  it('supervisor synopsis positively enumerates the surviving registry fleet', () => {
    const supervisor = read('scripts/orchestrator-wake-supervisor.ps1');
    const header = supervisor.slice(0, supervisor.indexOf('[CmdletBinding'));
    for (const id of survivors) expect(header).toContain(id);
    expect(header).not.toMatch(/\blistener\b/i);
    expect(header).not.toContain('heartbeat');
    expect(header).not.toContain('review-send-reconcile');
  });

  it('removes listener-only escalation and message bindings', () => {
    const emitter = json('scripts/orchestrator-escalation-emitter-inventory.json');
    const auditRoots = json('scripts/orchestrator-message-audit-roots.manifest.json');
    const protectedRuntime = json('scripts/orchestrator-message-protected-runtime.manifest.json');
    const catalog = json('scripts/orchestrator-message-catalog.json');
    const combined = JSON.stringify({ emitter, auditRoots, protectedRuntime, catalog });
    expect(combined).not.toContain('orchestrator-wake-listener.ps1');
    expect(combined).not.toContain('"owning_process":"listener"');
    expect(combined).not.toContain('escalation-handoff-envelope');
  });

  it('uses the AO 0.10 worker action for red CI', () => {
    const source = read('scripts/ci-failure-notification-reconcile.ps1');
    expect(source).toContain(
      'Required CI failed for your PR. Fix failing required checks and push.',
    );
    expect(source).not.toContain('ao report fixing_ci');
    expect(source).not.toContain('ao events');
    expect(source).not.toContain('ao status --reports');
  });

  it('retains the final-base listener disposition evidence', () => {
    const evidence = json('tests/fixtures/listener-disposition/retire.json');
    expect(evidence).toMatchObject({
      issue: 745,
      baseCommitSha: '9728896230f8f66de09c485dff613dfdee5cfd9f',
      aoVersion: '0.10.2',
      disposition: 'retire',
      productionAudit: { inboundWebhookPosts: 0 },
      finalBaseProbe: {
        command: 'node tests/listener-disposition-probe.mjs',
        observationWindowSeconds: 60,
        inboundWebhookPosts: 0,
        bindingVerified: true,
      },
    });
  });
});
