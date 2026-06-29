import type { ParsedGhArgv } from './gh-parse-argv.mjs';
import type { InventoryRoute } from './gh-inventory-match.mjs';

export function executeRestRoute(
  routeId: string,
  ctx: {
    realGh: string;
    parsed: ParsedGhArgv;
    route: InventoryRoute;
    cwd?: string;
  },
): unknown;
