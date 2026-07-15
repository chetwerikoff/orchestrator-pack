import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const repoRoot = join(import.meta.dirname, '..');
const auditLib = join(repoRoot, 'scripts/lib/Orchestrator-ReviewStartAudit.ps1').replace(/'/g, "''");
function walkPs1Files(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkPs1Files(fullPath));
            continue;
        }
        if (entry.isFile() && entry.name.endsWith('.ps1')) {
            files.push(fullPath);
        }
    }
    return files;
}
function listAuditWriterCallSites(functionName: string): Array<{
    file: string;
    lineNo: number;
    snippet: string;
}> {
    const matches: Array<{
        file: string;
        lineNo: number;
        snippet: string;
    }> = [];
    for (const file of walkPs1Files(join(repoRoot, 'scripts'))) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
            if (!line.includes(functionName) || line.includes(`function ${functionName}`)) {
                return;
            }
            matches.push({
                file,
                lineNo: index + 1,
                snippet: lines.slice(index, index + 7).join('\n'),
            });
        });
    }
    return matches;
}
describe('orchestrator review-start preflight refusal audit', () => {
    it('records PR and head identity keys on preflight refusals', () => {
        const root = mkdtempSync(join(tmpdir(), 'review-start-preflight-audit-'));
        try {
            const script = `
. '${auditLib}'
$result = Write-OrchestratorReviewStartPreflightRefusal -AuditRoot '${root.replace(/'/g, "''")}' -Reason 'gate_marker_missing' -MarkerState 'missing' -PrNumber 581 -HeadSha 'ABCDEF1234'
Get-Content -LiteralPath $result.path -Raw
`;
            const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], {
                cwd: repoRoot,
                encoding: 'utf8',
            });
            expect(result.status).toBe(0);
            const record = JSON.parse(result.stdout.trim());
            expect(record).toMatchObject({
                kind: 'preflight_refusal',
                prNumber: 581,
                headSha: 'abcdef1234',
                reason: 'gate_marker_missing',
                markerState: 'missing',
            });
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('keeps legacy unkeyed records readable for backward compatibility', () => {
        const root = mkdtempSync(join(tmpdir(), 'review-start-preflight-legacy-'));
        try {
            const script = `
. '${auditLib}'
$result = Write-OrchestratorReviewStartPreflightRefusal -AuditRoot '${root.replace(/'/g, "''")}' -Reason 'legacy' -MarkerState 'missing'
Get-Content -LiteralPath $result.path -Raw
`;
            const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], {
                cwd: repoRoot,
                encoding: 'utf8',
            });
            expect(result.status).toBe(0);
            const record = JSON.parse(result.stdout.trim());
            expect(record.prNumber).toBe(0);
            expect(record.headSha).toBe('');
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('fails closed under test context when AO_BASE_DIR is not isolated', () => {
        const script = `
. '${auditLib}'
Get-OrchestratorReviewStartAuditRoot -ProjectId 'orchestrator-pack'
`;
        const env = { ...process.env, VITEST_WORKER_ID: 'guard-check' } as Record<string, string>;
        delete env.AO_BASE_DIR;
        const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], {
            cwd: repoRoot,
            encoding: 'utf8',
            env,
        });
        expect(result.status).not.toBe(0);
        const combined = `${result.stdout}\n${result.stderr}`;
        expect(combined).toMatch(/requires AO_BASE_DIR/i);
        expect(combined).toMatch(/agent-orchestrator audit path/i);
    });
    it('requires PR/head arguments at every preflight refusal producer call site', () => {
        const callSites = listAuditWriterCallSites('Write-OrchestratorReviewStartPreflightRefusal');
        expect(callSites.length).toBeGreaterThan(0);
        for (const site of callSites) {
            expect(site.snippet).toMatch(/-PrNumber\b/);
            expect(site.snippet).toMatch(/-HeadSha\b/);
        }
    });
    it('does not regress denial audit PR/head keying at sibling call sites', () => {
        const callSites = listAuditWriterCallSites('Write-OrchestratorReviewStartDenialAudit');
        expect(callSites.length).toBeGreaterThan(0);
        for (const site of callSites) {
            expect(site.snippet).toMatch(/-PrNumber\b/);
            expect(site.snippet).toMatch(/-HeadSha\b/);
        }
    });
});
