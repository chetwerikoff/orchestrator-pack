from pathlib import Path

path = Path('.github/issue-1148-review-fixes.py')
text = path.read_text(encoding='utf-8')

start = text.index(
    'source = replace_once(\n'
    '    source,\n'
    '    block("""\n'
    '      const matching = observation.nodes.filter((node) => node.identity === boundary.anchorIdentity);'
)
end = text.index(
    'source = replace_once(\n'
    '    source,\n'
    '    "    nodes: observation.nodes.slice(anchor.domIndex + boundary.suffix.length),"',
    start,
)
replacement = '''post_tail_start = source.index(
    "  const matching = observation.nodes.filter((node) => node.identity === boundary.anchorIdentity);"
)
post_tail_end = source.index(
    "  for (let index = 0; index < boundary.suffix.length; index++) {",
    post_tail_start,
)
source = source[:post_tail_start] + (
    "  const matching = observation.nodes\\n"
    "    .map((node, index) => ({ node, index }))\\n"
    "    .filter(({ node }) => node.identity === boundary.anchorIdentity);\\n"
    "  if (matching.length > 1) return { state: 'changed' };\\n"
    "  if (matching.length === 0) {\\n"
    "    return observation.nodes.some((node) => node.identityReadFailed)\\n"
    "      ? { state: 'unresolved' }\\n"
    "      : { state: 'changed' };\\n"
    "  }\\n"
    "  const { node: anchor, index: anchorIndex } = matching[0]!;\\n"
    "  if (anchor.role !== 'user') return { state: 'changed' };\\n"
    "  const currentSuffix = observation.nodes.slice(\\n"
    "    anchorIndex,\\n"
    "    anchorIndex + boundary.suffix.length,\\n"
    "  );\\n"
    "  if (currentSuffix.length !== boundary.suffix.length) return { state: 'changed' };\\n"
) + source[post_tail_end:]

'''
text = text[:start] + replacement + text[end:]

start = text.index(
    'source = replace_once(\n'
    '    source,\n'
    '    block("""\n'
    '          const firstTail = await readPageObservation(page);'
)
end = text.index(
    'source = replace_once(\n'
    '    source,\n'
    '    "      boundMissingReads = 0;\\n"',
    start,
)
replacement = '''pre_send_start = source.index(
    "      const firstTail = await readPageObservation(page);"
)
pre_send_end = source.index(
    "      admissionCandidateIdentity = undefined;",
    pre_send_start,
)
source = source[:pre_send_start] + (
    "      const firstTail = await readTailPageObservation(page, config.newChat);\\n"
    "      await sleep(page, OWNED_TAIL_CONFIRM_DELAY_MS);\\n"
    "      const secondTail = await readTailPageObservation(page, config.newChat);\\n"
    "      ownedTailBoundary = establishOwnedTailBoundary(firstTail, secondTail, config.newChat);\\n"
    "      observationMode = ownedTailBoundary.kind === 'text_fallback' ? 'text_fallback' : 'admission';\\n"
    "      baselineCount = secondTail.nodeCount ?? secondTail.messages.length;\\n"
) + source[pre_send_end:]

'''
text = text[:start] + replacement + text[end:]

start = text.index(
    'source = replace_once(\n'
    '    source,\n'
    '    block("""\n'
    "            if (exactBound.state === 'missing') {"
)
end = text.index(
    'source = replace_once(\n'
    '    source,\n'
    '    "        boundUnresolvedReads = 0;\\n"',
    start,
)
replacement = '''missing_start = source.index(
    "        if (exactBound.state === 'missing') {"
)
missing_end = source.index(
    "          if (boundMissingReads >= OWNED_IDENTITY_MISSING_READS) {",
    missing_start,
)
source = source[:missing_start] + (
    "        if (exactBound.state === 'missing') {\\n"
    "          // DOM indices can shift as historical nodes materialize or virtualize.\\n"
    "          // Zero exact matches are bounded disappearance evidence unless another\\n"
    "          // current-page identity/role/topology contradiction exists.\\n"
    "          boundMissingReads += 1;\\n"
) + source[missing_end:]

'''
text = text[:start] + replacement + text[end:]

path.write_text(text, encoding='utf-8')
