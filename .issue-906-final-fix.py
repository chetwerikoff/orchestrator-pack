from pathlib import Path
import json

repo = Path('.')
generator = repo / 'scripts/estate-cut/manifest-generator.mjs'
text = generator.read_text()

# Retire the remaining TypeScript-only TestMode fleet helpers. The PowerShell
# lease/helper remain because surviving supervisor tests still consume them.
if "'scripts/testmode-fleet-harness.ts'" not in text:
    anchor = "  'docs/github-fleet-cache-measurement.md',\n"
    replacement = anchor + """  'scripts/testmode-fleet-harness.ts',
  'scripts/testmode-fleet-reaper.shared.ts',
  'scripts/vitest-testmode-fleet-progress.ts',
"""
    if text.count(anchor) != 1:
        raise SystemExit('issue-906 explicit-delete anchor drifted')
    text = text.replace(anchor, replacement, 1)

# Keep committed inventories self-consistent when their referenced helpers die.
if "'scripts/launch-argv-test-exclusions.manifest.json'" not in text:
    old = "'scripts/toolchain/powershell-child-tests.json', 'scripts/toolchain/raw-child-process-baseline.json'])"
    new = "'scripts/toolchain/powershell-child-tests.json', 'scripts/toolchain/raw-child-process-baseline.json', 'scripts/launch-argv-test-exclusions.manifest.json'])"
    if text.count(old) != 1:
        raise SystemExit('issue-906 JSON-prune anchor drifted')
    text = text.replace(old, new, 1)

# A generated manifest must not be an input to its own reachability graph.
if 'function buildReachabilityWithoutGeneratedManifest()' not in text:
    anchor = "function readCurrent(rel) { return readFileSync(path.join(repoRoot, rel)); }\n"
    helper = anchor + """async function buildReachabilityWithoutGeneratedManifest() {
  const full = path.join(repoRoot, MANIFEST);
  const bytes = existsSync(full) ? readFileSync(full) : null;
  if (bytes) rmSync(full, { force: true });
  try {
    return await buildReachabilityManifest(repoRoot);
  } finally {
    if (bytes) writeFileSync(full, bytes);
  }
}
"""
    if text.count(anchor) != 1:
        raise SystemExit('issue-906 reachability helper anchor drifted')
    text = text.replace(anchor, helper, 1)
    call = "  const reachability = await buildReachabilityManifest(repoRoot);\n"
    if text.count(call) != 1:
        raise SystemExit('issue-906 reachability call anchor drifted')
    text = text.replace(call, "  const reachability = await buildReachabilityWithoutGeneratedManifest();\n", 1)

# Replace the brittle line-oriented verify rewrite with a section-aware rewrite.
start = text.index('function removeDeletedVerifyMembers')
end = text.index('function verifyAnchor()', start)
replacement = r'''function pruneDeletedPowerShellPathEntries(text, deletedSet) {
  const lines = text.split(/\r?\n/u).filter((line) => {
    const match = /^\s*'([^']+)'\s*,?\s*$/u.exec(line);
    return !(match && deletedSet.has(normalize(match[1])));
  });
  return `${lines.join('\n').trimEnd()}\n`;
}
function removeDeletedVerifyMembers(text, deletedSet) {
  const originalLines = text.split(/\r?\n/u);
  const deletedChecks = [...deletedSet].filter((rel) => rel.startsWith('scripts/check-'));
  const heading = /^\s*Write-Host\s+['"]==.*==['"]\s*$/u;
  const sectionStarts = originalLines
    .map((line, index) => heading.test(line) ? index : -1)
    .filter((index) => index >= 0);
  sectionStarts.push(originalLines.length);
  const removedLineIndexes = new Set();
  for (let sectionIndex = 0; sectionIndex < sectionStarts.length - 1; sectionIndex += 1) {
    const sectionStart = sectionStarts[sectionIndex];
    const sectionEnd = sectionStarts[sectionIndex + 1];
    const refs = new Set((originalLines.slice(sectionStart, sectionEnd).join('\n')
      .match(/scripts\/check-[A-Za-z0-9._-]+\.ps1/gu) ?? []));
    if (refs.size > 0 && [...refs].every((rel) => deletedSet.has(rel))) {
      for (let index = sectionStart; index < sectionEnd; index += 1) removedLineIndexes.add(index);
    }
  }

  const lines = originalLines.filter((_, index) => !removedLineIndexes.has(index));
  const output = [];
  const retiredInlineMarkers = new Set([
    'verify-runtime/autonomous-spawn-budget-vitest',
    'verify-runtime/autonomous-spawn-policy-vitest',
  ]);
  const containsDeletedCheck = (line) => deletedChecks.some((rel) => line.includes(rel));
  const braceDelta = (line) => (line.match(/\{/gu) ?? []).length - (line.match(/\}/gu) ?? []).length;
  const skipBalancedBlock = (blockStart) => {
    let index = blockStart;
    let depth = 0;
    let opened = false;
    while (index < lines.length) {
      const line = lines[index];
      depth += braceDelta(line);
      if (line.includes('{')) opened = true;
      index += 1;
      if (opened && depth <= 0) break;
    }
    return index;
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if ([...retiredInlineMarkers].some((marker) => line.includes(`Write-Check '${marker}'`))) {
      index += 1;
      continue;
    }
    if (!containsDeletedCheck(line)) {
      output.push(line);
      index += 1;
      continue;
    }
    const isAssignment = /^\s*\$[A-Za-z_][A-Za-z0-9_]*\s*=\s*Join-Path\b/u.test(line);
    if (!isAssignment) {
      index += 1;
      continue;
    }
    index += 1;
    while (index < lines.length && /^\s*$/u.test(lines[index])) index += 1;
    if (index < lines.length && /^\s*if\b/u.test(lines[index])) {
      index = skipBalancedBlock(index);
      while (index < lines.length && /^\s*$/u.test(lines[index])) index += 1;
      if (index < lines.length && /^\s*else\b/u.test(lines[index])) index = skipBalancedBlock(index);
    }
  }
  const rewritten = output.join('\n')
    .replace(/,\n(\s*\)\)\s*\{)/gu, '\n$1')
    .replace(/\n{4,}/gu, '\n\n\n')
    .trimEnd();
  return `${rewritten}\n`;
}
'''
text = text[:start] + replacement + text[end:]

# Pinned guards may enumerate deleted subjects; prune only exact quoted paths.
if "const deadArgvPath = path.join(repoRoot, 'scripts/check-ao-dead-argv-bypass.ps1');" not in text:
    anchor = "  writeFileSync(verifyPath, removeDeletedVerifyMembers(baseVerify.toString('utf8'), deletedSet));\n\n"
    addition = anchor + """  const deadArgvPath = path.join(repoRoot, 'scripts/check-ao-dead-argv-bypass.ps1');
  if (existsSync(deadArgvPath)) {
    writeFileSync(deadArgvPath, pruneDeletedPowerShellPathEntries(readFileSync(deadArgvPath, 'utf8'), deletedSet));
  }

"""
    if text.count(anchor) != 1:
        raise SystemExit('issue-906 dead-argv prune anchor drifted')
    text = text.replace(anchor, addition, 1)

generator.write_text(text)

lanes_path = repo / 'scripts/vitest-ci-lanes.config.json'
lanes = json.loads(lanes_path.read_text())
lanes['classification']['scripts/estate-cut/issue-906-vertical-slice.test.ts'] = 'light'
lanes['classification'] = dict(sorted(lanes['classification'].items()))
lanes_path.write_text(json.dumps(lanes, indent=2) + '\n')
