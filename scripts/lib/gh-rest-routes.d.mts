import type { ParsedGhArgv } from './gh-parse-argv.mjs';
import type { InventoryRoute } from './gh-inventory-match.mjs';

export function parsePullReference(
  ref: string,
): { prNumber: number; slug?: string; host?: string | null } | null;

export function routePrView(
  realGh: string,
  repo: { slug: string; host: string },
  prRef: string,
  fields: string[],
  jq: string | null,
  cwd: string,
): unknown;

export function executeRestRoute(
  routeId: string,
  ctx: {
    realGh: string;
    parsed: ParsedGhArgv;
    route: InventoryRoute;
    cwd?: string;
  },
): unknown;
