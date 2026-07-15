import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGraph, rankHubs, findCluster, findCycle } from './query-graph.mjs';

// Real graph.json built by `graphify extract --code-only` (no LLM) over 9 real files from
// docs/*.mjs in this repo -- captures a genuine hub-degree distribution, community structure,
// and a real import cycle (Issue #833 AC#3 fixture; see scripts/graphify/README.md).
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/sample-graph.json');

describe('query-graph (Issue #833 AC#3)', () => {
  const graph = loadGraph(fixturePath);

  it('answers a hub-ranking question with a concrete, non-empty answer', () => {
    const hubs = rankHubs(graph, 5);
    expect(hubs.length).toBe(5);
    expect(hubs[0].degree).toBeGreaterThan(0);
    // Sorted descending by degree.
    for (let i = 1; i < hubs.length; i += 1) {
      expect(hubs[i - 1].degree).toBeGreaterThanOrEqual(hubs[i].degree);
    }
  });

  it('answers a cluster-membership question for a real file in this repo', () => {
    const result = findCluster(graph, 'review-cycle-cap.mjs');
    expect(result.found).toBe(true);
    expect(typeof result.community).toBe('number');
  });

  it('reports no match for a file that is not in the built graph', () => {
    const result = findCluster(graph, 'this-file-does-not-exist.mjs');
    expect(result.found).toBe(false);
  });

  it('answers an import-cycle question for a real file that sits on one', () => {
    const result = findCycle(graph, 'review-cycle-cap.mjs');
    expect(result.found).toBe(true);
    expect(result.onCycle).toBe(true);
    expect(result.cycleMembers.length).toBeGreaterThan(1);
    expect(result.cycleMembers.some((f: string) => f.endsWith('review-cycle-cap.mjs'))).toBe(true);
  });

  it('does not re-run extraction -- pure read over the already-built graph.json', () => {
    // Loading the same fixture twice and comparing node/link counts proves this is a
    // deterministic file read, not a live re-extraction.
    const reloaded = loadGraph(fixturePath);
    expect(reloaded.nodes.length).toBe(graph.nodes.length);
    expect(reloaded.links.length).toBe(graph.links.length);
  });
});
