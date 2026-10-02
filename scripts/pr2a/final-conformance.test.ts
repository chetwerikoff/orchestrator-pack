import { describe, expect, it } from 'vitest';
import { buildConformanceReport, scanForbiddenExecutableReferences } from './final-conformance.ts';

describe('Issue #948 current final conformance', () => {
  it('accepts the current committed hard-cut tree', () => {
    const report = buildConformanceReport('HEAD');
    expect(report.result, JSON.stringify(report.findings, null, 2)).toBe('conformant');
  });
  it('rejects an executable edge back to a retired D928 PowerShell surface', () => {
    const findings = scanForbiddenExecutableReferences([{ path:'scripts/example.ts', content:"spawn('pwsh', ['-File', 'Review-StartClaim.ps1']);\n" }]);
    expect(findings.map((row)=>row.code)).toContain('d928_external_executable_reference');
  });
  it('allows inert historical vocabulary without an execution primitive', () => {
    expect(scanForbiddenExecutableReferences([{ path:'scripts/example.ts', content:"const retiredName = 'Review-StartClaim.ps1';\n" }])).toEqual([]);
  });
});
