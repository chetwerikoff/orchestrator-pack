export type SemanticNode =
  | { type: 'text'; text: string }
  | { type: 'paragraph'; children: SemanticNode[] }
  | { type: 'heading'; children: SemanticNode[] }
  | { type: 'unordered_list'; items: SemanticNode[][] }
  | { type: 'ordered_list'; items: Array<{ ordinal: string; children: SemanticNode[] }> }
  | { type: 'blockquote'; children: SemanticNode[] }
  | { type: 'code_block'; text: string }
  | { type: 'inline_code'; text: string }
  | { type: 'link'; children: SemanticNode[] }
  | { type: 'line_break' }
  | { type: 'group'; children: SemanticNode[] };

export const SEMANTIC_UI_FILTER = {
  skippedTags: ['button', 'svg', 'script', 'style', 'noscript', 'time'],
  testidPattern: 'copy|feedback|thumb|citation.*(?:chip|hover)|code.*badge|toolbar|control',
  classPattern: 'sr-only|visually-hidden',
} as const;

export interface SemanticElementDescriptor {
  readonly tag: string;
  readonly ariaHidden?: string | null;
  readonly testid?: string | null;
  readonly className?: string | null;
}

export function shouldSkipSemanticElement(element: SemanticElementDescriptor): boolean {
  const tag = element.tag.toLowerCase();
  if ((SEMANTIC_UI_FILTER.skippedTags as readonly string[]).includes(tag)) return true;
  if (element.ariaHidden === 'true') return true;
  if (new RegExp(SEMANTIC_UI_FILTER.testidPattern, 'i').test(element.testid ?? '')) return true;
  if (new RegExp(SEMANTIC_UI_FILTER.classPattern, 'i').test(element.className ?? '')) return true;
  return false;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function inline(nodes: SemanticNode[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text': out += normalizeNewlines(node.text); break;
      case 'inline_code': out += normalizeNewlines(node.text); break;
      case 'link': out += inline(node.children); break;
      case 'line_break': out += '\n'; break;
      case 'group': out += inline(node.children); break;
      case 'paragraph':
      case 'heading': out += inline(node.children); break;
      case 'code_block': out += normalizeNewlines(node.text); break;
      case 'blockquote': out += serializeSemanticNodes(node.children); break;
      case 'unordered_list':
      case 'ordered_list': out += serializeNode(node, 0); break;
    }
  }
  return out;
}

function indentLines(value: string, prefix: string): string {
  return value.split('\n').map((line, index) => index === 0 ? line : `${prefix}${line}`).join('\n');
}

function serializeListChildren(children: SemanticNode[], depth: number): string {
  return serializeSemanticNodes(children, depth + 1);
}

function serializeNode(node: SemanticNode, depth: number): string {
  switch (node.type) {
    case 'text': return normalizeNewlines(node.text);
    case 'paragraph':
    case 'heading': return inline(node.children).trim();
    case 'inline_code': return normalizeNewlines(node.text);
    case 'link': return inline(node.children);
    case 'line_break': return '\n';
    case 'code_block': return normalizeNewlines(node.text).replace(/\n$/, '');
    case 'group': return serializeSemanticNodes(node.children, depth);
    case 'blockquote': {
      const body = serializeSemanticNodes(node.children, depth);
      return body.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n');
    }
    case 'unordered_list': {
      const prefix = '  '.repeat(depth);
      return node.items.map((children) => {
        const body = serializeListChildren(children, depth).trim();
        return `${prefix}- ${indentLines(body, `${prefix}  `)}`.trimEnd();
      }).join('\n');
    }
    case 'ordered_list': {
      const prefix = '  '.repeat(depth);
      return node.items.map(({ ordinal, children }) => {
        const marker = `${ordinal}. `;
        const body = serializeListChildren(children, depth).trim();
        return `${prefix}${marker}${indentLines(body, `${prefix}${' '.repeat(marker.length)}`)}`.trimEnd();
      }).join('\n');
    }
  }
}

export function serializeSemanticNodes(nodes: SemanticNode[], depth = 0): string {
  const blocks: string[] = [];
  for (const node of nodes) {
    const value = serializeNode(node, depth);
    if (!value) continue;
    const blockLike = ['paragraph','heading','unordered_list','ordered_list','blockquote','code_block','group'].includes(node.type);
    if (blockLike) blocks.push(value.trimEnd());
    else if (blocks.length === 0) blocks.push(value);
    else {
      const index = blocks.length - 1;
      blocks[index] = `${blocks[index] ?? ''}${value}`;
    }
  }
  return blocks.filter((value) => value.length > 0).join('\n\n').replace(/\n+$/, '');
}

function overlapLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  for (let size = max; size >= 1; size--) {
    if (left.slice(-size) !== right.slice(0, size)) continue;
    if (size >= 32 || left.slice(-size).startsWith('\n') || right.slice(0, size).endsWith('\n')) return size;
  }
  return 0;
}

export function mergeContinuationSegments(segments: string[]): string {
  let merged = '';
  for (const raw of segments) {
    const segment = normalizeNewlines(raw).replace(/\n+$/, '');
    if (!segment) continue;
    if (!merged) { merged = segment; continue; }
    if (segment === merged || merged.endsWith(segment)) continue;
    if (segment.startsWith(merged)) { merged = segment; continue; }
    const overlap = overlapLength(merged, segment);
    if (overlap > 0) merged += segment.slice(overlap);
    else merged += `\n\n${segment}`;
  }
  return merged.replace(/\n+$/, '');
}
