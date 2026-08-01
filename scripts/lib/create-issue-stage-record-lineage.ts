import type {
  CanonicalLineage,
  LineageDiagnostic,
  ParsedJournalEvent,
} from './create-issue-stage-record-types.ts';
import { CYCLE_SCHEMA } from './create-issue-stage-record-types.ts';

function cyclePayload(event: ParsedJournalEvent): {
  cycleId: string;
  predecessor: string;
} | null {
  if (event.schema !== CYCLE_SCHEMA) return null;
  const logical = event.logical;
  if (logical.schema !== CYCLE_SCHEMA) return null;
  return {
    cycleId: logical['cycle-id'],
    predecessor: logical['predecessor-cycle-id'],
  };
}

function sortEvents(events: ParsedJournalEvent[]): ParsedJournalEvent[] {
  return [...events].sort((a, b) => {
    const at = Date.parse(a.createdAt);
    const bt = Date.parse(b.createdAt);
    if (at !== bt) return at - bt;
    return a.commentId - b.commentId;
  });
}

export function buildCanonicalLineage(events: ParsedJournalEvent[]): CanonicalLineage {
  const diagnostics: LineageDiagnostic[] = [];
  const eventsByKey = new Map<string, ParsedJournalEvent>();
  const cycleEvents = events.filter((event) => event.schema === CYCLE_SCHEMA);

  for (const event of sortEvents(events)) {
    const existing = eventsByKey.get(event.eventKey);
    if (!existing) {
      eventsByKey.set(event.eventKey, event);
      continue;
    }
    if (existing.fingerprint === event.fingerprint) {
      diagnostics.push({
        code: 'duplicate-remote-event',
        message: `duplicate logical event ${event.eventKey}`,
        eventKey: event.eventKey,
        commentId: event.commentId,
      });
      continue;
    }
    diagnostics.push({
      code: event.schema === CYCLE_SCHEMA ? 'conflicting-cycle-id' : 'conflicting-remote-event',
      message: `conflicting logical event ${event.eventKey}`,
      eventKey: event.eventKey,
      commentId: event.commentId,
    });
  }

  const canonicalCycles = sortEvents(
    cycleEvents.filter((event) => {
      const canonical = eventsByKey.get(event.eventKey);
      return canonical?.commentId === event.commentId;
    }),
  );

  const roots = canonicalCycles.filter((event) => {
    const payload = cyclePayload(event);
    return payload?.predecessor === 'none';
  });

  let canonicalRoot: ParsedJournalEvent | null = null;
  if (roots.length > 0) {
    canonicalRoot = sortEvents(roots)[0] ?? null;
    for (const root of roots) {
      if (canonicalRoot && root.commentId !== canonicalRoot.commentId) {
        diagnostics.push({
          code: 'non-current-cycle-root',
          message: `non-canonical root ${root.eventKey}`,
          eventKey: root.eventKey,
          commentId: root.commentId,
        });
      }
    }
  }

  const admitted = new Map<string, ParsedJournalEvent>();
  if (canonicalRoot) {
    const payload = cyclePayload(canonicalRoot);
    if (payload) admitted.set(payload.cycleId, canonicalRoot);
  }

  const pending = sortEvents(
    canonicalCycles.filter((event) => eventsByKey.get(event.eventKey)?.commentId === event.commentId),
  );

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const event of pending) {
      const payload = cyclePayload(event);
      if (!payload) continue;
      if (admitted.has(payload.cycleId)) continue;
      if (payload.cycleId === payload.predecessor) {
        diagnostics.push({
          code: 'cyclic-cycle-lineage',
          message: `self-referential cycle ${payload.cycleId}`,
          eventKey: event.eventKey,
          commentId: event.commentId,
        });
        continue;
      }
      if (payload.predecessor === 'none') continue;
      const predecessor = admitted.get(payload.predecessor);
      if (!predecessor) {
        diagnostics.push({
          code: 'orphan-cycle',
          message: `orphan cycle ${payload.cycleId}`,
          eventKey: event.eventKey,
          commentId: event.commentId,
        });
        continue;
      }
      const siblings = pending.filter((candidate) => {
        const candidatePayload = cyclePayload(candidate);
        return candidatePayload?.predecessor === payload.predecessor;
      });
      const winner = sortEvents(siblings)[0];
      if (winner && winner.commentId !== event.commentId) {
        diagnostics.push({
          code: 'non-current-cycle-fork',
          message: `non-current fork for predecessor ${payload.predecessor}`,
          eventKey: event.eventKey,
          commentId: event.commentId,
        });
        continue;
      }
      admitted.set(payload.cycleId, event);
      progressed = true;
    }
  }

  let head: ParsedJournalEvent | null = null;
  for (const event of admitted.values()) {
    if (!head) {
      head = event;
      continue;
    }
    const headAt = Date.parse(head.createdAt);
    const eventAt = Date.parse(event.createdAt);
    if (eventAt > headAt || (eventAt === headAt && event.commentId > head.commentId)) {
      head = event;
    }
  }

  return {
    roots,
    canonicalRoot,
    head,
    eventsByKey,
    diagnostics,
  };
}

export function hasBlockingLineageConflict(lineage: CanonicalLineage, eventKey: string): boolean {
  return lineage.diagnostics.some((item) => {
    if (item.eventKey !== eventKey) return false;
    return item.code === 'conflicting-cycle-id' || item.code === 'conflicting-remote-event';
  });
}
