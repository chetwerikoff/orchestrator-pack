import type { ParsedGhArgv } from './gh-parse-argv.mjs';

export type InventoryRouteId =
  | 'pr-list-open'
  | 'pr-list-head'
  | 'pr-list-merged-closes'
  | 'pr-view'
  | 'pr-checks'
  | 'pr-diff-name-only'
  | 'issue-view-body'
  | 'issue-view-json'
  | 'repo-view-name-with-owner';

export function executeRestRoute(
  routeId: InventoryRouteId,
  ctx: {
    realGh: string;
    parsed: ParsedGhArgv;
    route: { id: InventoryRouteId; prNumber?: number; branch?: string };
    cwd?: string;
  },
): unknown;

export function routePrView(
  realGh: string,
  repo: { slug: string; host: string },
  prNumber: number,
  fields: string[],
  jq: string | null,
  cwd: string,
): unknown;

export function mapPullState(pull: Record<string, unknown>): string;
