// Scope-guard compatibility surface; every matching decision lives in shared.
export {
  parsePathPattern,
  matchesPathPattern as matchesGlob,
  pathMatchesAnyPattern,
  pathPatternWithin as globIsWithinAllowedRoot,
  pathPatternsOverlap as globPatternsOverlap,
  type ParsedPathPattern,
  type PathPatternKind,
  type PathPatternParseResult,
} from '@orchestrator-pack/shared/lib/path_pattern.js';
