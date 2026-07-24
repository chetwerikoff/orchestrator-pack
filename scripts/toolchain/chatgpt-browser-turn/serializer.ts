export type SemanticNode =
  | { kind:'text'; text:string }
  | { kind:'paragraph'|'heading'|'blockquote'; children:SemanticNode[] }
  | { kind:'code'; text:string }
  | { kind:'list'; ordered:boolean; start?:number; items:SemanticNode[][] }
  | { kind:'break' }
  | { kind:'link'; children:SemanticNode[] }
  | { kind:'group'; children:SemanticNode[] };

function inline(nodes: SemanticNode[]): string { return nodes.map(render).join('').replace(/[ \t]+\n/g, '\n'); }
function blockJoin(parts: string[]): string { return parts.map((p)=>p.trimEnd()).filter(Boolean).join('\n\n'); }

function renderList(node: Extract<SemanticNode,{kind:'list'}>): string {
  const start = node.start ?? 1;
  return node.items.map((children, index) => {
    const raw = blockJoin(children.map(render));
    const marker = node.ordered ? `${start + index}. ` : '- ';
    return raw.split('\n').map((line,i)=> i === 0 ? marker + line : '  ' + line).join('\n');
  }).join('\n');
}

export function render(node: SemanticNode): string {
  switch (node.kind) {
    case 'text': return node.text;
    case 'code': return node.text.replace(/\r\n?/g,'\n');
    case 'break': return '\n';
    case 'link': return inline(node.children);
    case 'paragraph': case 'heading': return inline(node.children).trim();
    case 'blockquote': return inline(node.children).trim().split('\n').map((l)=>`> ${l}`).join('\n');
    case 'list': return renderList(node);
    case 'group': return blockJoin(node.children.map(render));
  }
}

export function serializeSemanticReply(nodes: SemanticNode[]): string {
  const result = blockJoin(nodes.map(render)).replace(/\r\n?/g,'\n');
  return result.replace(/\n+$/,'');
}

export function mergeContinuationSegments(segments: string[]): string {
  let out = '';
  for (const segment of segments.map((s)=>s.replace(/\r\n?/g,'\n'))) {
    if (!out) { out = segment; continue; }
    if (segment === out || out.endsWith(segment)) continue;
    if (segment.startsWith(out)) { out = segment; continue; }
    let overlap = Math.min(out.length, segment.length);
    while (overlap > 0 && out.slice(-overlap) !== segment.slice(0,overlap)) overlap--;
    out += segment.slice(overlap);
  }
  return out.replace(/\n+$/,'');
}
