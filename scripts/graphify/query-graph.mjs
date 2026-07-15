/**
 * Worker-facing query surface over an already-built Graphify graph.json (Issue #833, AC#3).
 * Answers three questions without re-running extraction: which files/symbols have the most
 * edges ("hubs"), which cluster/community a named file belongs to, and whether a named file
 * sits on an import/call cycle. Pure reader over graph.json -- no `graphify` subprocess call.
 * Vitest: scripts/graphify/query-graph.test.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// Resolve the default graph path against the repo root (this file lives at
// scripts/graphify/query-graph.mjs) rather than the current working directory, so the CLI
// works the same regardless of where it's invoked from.
const DEFAULT_GRAPH_PATH = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  '.graphify/graph/graphify-out/graph.json',
);

const FILE_LEVEL_RELATIONS = new Set([
  'imports_from',
  're_exports',
  'calls',
  'indirect_call',
  'references',
  'extends',
  'inherits',
]);

export function loadGraph(graphPath) {
  const raw = readFileSync(graphPath, 'utf8');
  return JSON.parse(raw);
}

function degreeByNodeId(graph) {
  const degree = new Map();
  for (const node of graph.nodes) degree.set(node.id, 0);
  for (const link of graph.links) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }
  return degree;
}

/** Top-N nodes (file or symbol) by total edge count. */
export function rankHubs(graph, top = 10) {
  const degree = degreeByNodeId(graph);
  return [...graph.nodes]
    .map((node) => ({
      label: node.label,
      sourceFile: node.source_file ?? null,
      degree: degree.get(node.id) ?? 0,
    }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, top);
}

function normalizeFragment(fragment) {
  return fragment.replace(/\\/g, '/');
}

function findFileNode(graph, fileFragment) {
  const fragment = normalizeFragment(fileFragment);
  const byPath = graph.nodes.find(
    (node) =>
      node.source_location === 'L1' &&
      typeof node.source_file === 'string' &&
      normalizeFragment(node.source_file).endsWith(fragment),
  );
  if (byPath) return byPath;
  return graph.nodes.find((node) => node.source_location === 'L1' && node.label === fragment) ?? null;
}

/** Community/cluster id for a named file, plus sibling files in the same community. */
export function findCluster(graph, fileFragment) {
  const node = findFileNode(graph, fileFragment);
  if (!node) return { found: false, file: fileFragment };
  const siblings = graph.nodes
    .filter((n) => n.source_location === 'L1' && n.community === node.community && n.id !== node.id)
    .map((n) => n.source_file ?? n.label);
  return {
    found: true,
    file: node.source_file ?? node.label,
    community: node.community,
    siblingFiles: siblings,
  };
}

function fileLevelEdges(graph) {
  const sourceFileOf = new Map(graph.nodes.map((n) => [n.id, n.source_file ?? n.label]));
  const edges = new Set();
  const adjacency = new Map();
  for (const link of graph.links) {
    if (!FILE_LEVEL_RELATIONS.has(link.relation)) continue;
    const from = sourceFileOf.get(link.source);
    const to = sourceFileOf.get(link.target);
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    if (edges.has(key)) continue;
    edges.add(key);
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    adjacency.get(from).add(to);
  }
  return adjacency;
}

/** Tarjan's SCC over the file-level rollup graph; returns cyclic components (size > 1) only. */
function stronglyConnectedComponents(adjacency) {
  let index = 0;
  const indices = new Map();
  const low = new Map();
  const onStack = new Map();
  const stack = [];
  const sccs = [];

  function strongconnect(v) {
    indices.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.set(v, true);
    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.get(w)) {
        low.set(v, Math.min(low.get(v), indices.get(w)));
      }
    }
    if (low.get(v) === indices.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.set(w, false);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) sccs.push(component);
    }
  }

  for (const v of adjacency.keys()) {
    if (!indices.has(v)) strongconnect(v);
  }
  return sccs;
}

/** Whether a named file sits on an import/call cycle, and the cycle's member files if so. */
export function findCycle(graph, fileFragment) {
  const node = findFileNode(graph, fileFragment);
  if (!node) return { found: false, file: fileFragment };
  const targetFile = node.source_file ?? node.label;
  const adjacency = fileLevelEdges(graph);
  const sccs = stronglyConnectedComponents(adjacency);
  const owning = sccs.find((component) => component.includes(targetFile));
  return {
    found: true,
    file: targetFile,
    onCycle: Boolean(owning),
    cycleMembers: owning ?? [],
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true;
      flags[key] = value;
      if (value !== true) i += 1;
    }
  }
  return { command, flags };
}

function runCli(argv) {
  const { command, flags } = parseArgs(argv);
  const graphPath = flags.graph ?? DEFAULT_GRAPH_PATH;
  const graph = loadGraph(graphPath);

  if (command === 'hubs') {
    const top = flags.top ? Number(flags.top) : 10;
    console.log(JSON.stringify(rankHubs(graph, top), null, 2));
    return 0;
  }
  if (command === 'cluster') {
    if (!flags.file) throw new Error('cluster requires --file <path-or-name>');
    console.log(JSON.stringify(findCluster(graph, flags.file), null, 2));
    return 0;
  }
  if (command === 'cycle') {
    if (!flags.file) throw new Error('cycle requires --file <path-or-name>');
    console.log(JSON.stringify(findCycle(graph, flags.file), null, 2));
    return 0;
  }
  throw new Error(`Unknown command '${command}'. Expected one of: hubs, cluster, cycle.`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`[graphify query] ${error.message}`);
    process.exitCode = 1;
  }
}
