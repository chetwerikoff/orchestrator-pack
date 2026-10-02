import { describe, expect, it } from 'vitest';

type Binding = { pr: number; head: string; worker: string };
type Claim = { owner: string; acquiredAt: number };
type JournalEntry = { pr: number; head: string; verdict: 'PASS' | 'FAIL' };

class FakeBoundary {
  readonly events: string[] = [];
  readonly claims = new Map<string, Claim>();
  readonly journal: JournalEntry[] = [];
  readonly comments: { pr: number; head: string }[] = [];
  readonly statuses: { head: string; state: 'success' | 'failure' }[] = [];
  readonly workerMessages: { worker: string; head: string }[] = [];
  currentHead = 'a'.repeat(40);
  binding: Binding = { pr: 906, head: this.currentHead, worker: 'worker-906' };

  discover(bound: Binding): Binding {
    this.events.push('discover-exact-pr-head');
    if (bound.pr !== this.binding.pr || bound.head !== this.currentHead) throw new Error('binding drift');
    return { ...bound };
  }

  claim(bound: Binding, owner: string, now: number): boolean {
    const key = `${bound.pr}:${bound.head}`;
    if (this.claims.has(key)) return false;
    this.claims.set(key, { owner, acquiredAt: now });
    this.events.push('atomic-claim');
    return true;
  }

  reapStale(now: number, ttl: number): number {
    let released = 0;
    for (const [key, claim] of this.claims) {
      if (now - claim.acquiredAt > ttl) {
        this.claims.delete(key);
        released += 1;
      }
    }
    if (released > 0) this.events.push('stale-claim-reaped');
    return released;
  }

  runReviewer(bound: Binding): 'PASS' {
    this.events.push(`runner-wrapper:${bound.head}`);
    this.events.push(`reviewer-wrapper:${bound.head}`);
    return 'PASS';
  }

  persistVerdict(bound: Binding, verdict: 'PASS' | 'FAIL'): void {
    this.journal.push({ pr: bound.pr, head: bound.head, verdict });
    this.events.push('journal-first-verdict');
  }

  comment(bound: Binding): void {
    if (!this.journal.some((entry) => entry.pr === bound.pr && entry.head === bound.head)) throw new Error('comment before journal');
    this.comments.push({ pr: bound.pr, head: bound.head });
    this.events.push('github-comment-exact-head');
  }

  setRequiredStatus(bound: Binding, verdict: 'PASS' | 'FAIL'): void {
    this.statuses.push({ head: bound.head, state: verdict === 'PASS' ? 'success' : 'failure' });
    this.events.push('required-status-exact-head');
  }

  notifyWorker(bound: Binding): void {
    if (!this.workerMessages.some((message) => message.worker === bound.worker && message.head === bound.head)) {
      this.workerMessages.push({ worker: bound.worker, head: bound.head });
    }
    this.events.push('worker-message-once');
  }

  admitMerge(bound: Binding): boolean {
    this.events.push('merge-admission-reread');
    return this.currentHead === bound.head
      && this.statuses.some((status) => status.head === bound.head && status.state === 'success');
  }
}

function executeTargetCycle(boundary: FakeBoundary): boolean {
  const binding = boundary.discover(boundary.binding);
  if (!boundary.claim(binding, 'review-runner', 100)) return false;
  const verdict = boundary.runReviewer(binding);
  boundary.persistVerdict(binding, verdict);
  boundary.comment(binding);
  boundary.setRequiredStatus(binding, verdict);
  boundary.notifyWorker(binding);
  boundary.notifyWorker(binding);
  return boundary.admitMerge(binding);
}

describe('Issue #906 target-cycle vertical slice', () => {
  it('keeps one exact PR/head identity through claim, verdict delivery, worker notification, and merge admission', () => {
    const boundary = new FakeBoundary();
    expect(executeTargetCycle(boundary)).toBe(true);
    expect(boundary.comments).toEqual([{ pr: 906, head: 'a'.repeat(40) }]);
    expect(boundary.statuses).toEqual([{ head: 'a'.repeat(40), state: 'success' }]);
    expect(boundary.workerMessages).toEqual([{ worker: 'worker-906', head: 'a'.repeat(40) }]);
    expect(boundary.events).toEqual([
      'discover-exact-pr-head',
      'atomic-claim',
      `runner-wrapper:${'a'.repeat(40)}`,
      `reviewer-wrapper:${'a'.repeat(40)}`,
      'journal-first-verdict',
      'github-comment-exact-head',
      'required-status-exact-head',
      'worker-message-once',
      'worker-message-once',
      'merge-admission-reread',
    ]);
  });

  it('refuses a second live claim and allows a stale claim to be reaped', () => {
    const boundary = new FakeBoundary();
    const binding = boundary.discover(boundary.binding);
    expect(boundary.claim(binding, 'first', 100)).toBe(true);
    expect(boundary.claim(binding, 'second', 101)).toBe(false);
    expect(boundary.reapStale(1_000, 100)).toBe(1);
    expect(boundary.claim(binding, 'second', 1_001)).toBe(true);
  });

  it('rejects merge when the PR head changes after delivery', () => {
    const boundary = new FakeBoundary();
    const binding = boundary.discover(boundary.binding);
    expect(boundary.claim(binding, 'review-runner', 100)).toBe(true);
    const verdict = boundary.runReviewer(binding);
    boundary.persistVerdict(binding, verdict);
    boundary.comment(binding);
    boundary.setRequiredStatus(binding, verdict);
    boundary.notifyWorker(binding);
    boundary.currentHead = 'b'.repeat(40);
    expect(boundary.admitMerge(binding)).toBe(false);
  });
});
