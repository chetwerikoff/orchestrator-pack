import { readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import ts from 'typescript';
import {
  compareRawChildProcessBaseline,
  discoverRawChildProcessCalls,
  makeRawChildProcessBaseline,
  type RawChildProcessBaseline,
} from '#opk-toolchain/child-process-policy';
import { isDirectExecution, writeVersionOneBaseline } from '#opk-toolchain/baseline-io';

export interface PolicyViolation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly rule: 'floating-promise' | 'misused-promise' | 'raw-child-process';
  readonly message: string;
}

function normalizedPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function isFoundationProductionPath(root: string, fileName: string): boolean {
  const path = normalizedPath(root, fileName);
  return path === 'scripts/typescript-smoke.ts'
    || (/^scripts\/(kernel|toolchain)\/.*\.ts$/.test(path) && !path.endsWith('.test.ts'));
}

function isThenable(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
  if (type.isUnion()) return type.types.some((nested) => isThenable(nested, checker));
  return checker.getPropertyOfType(type, 'then') !== undefined;
}

function isAsyncFunction(node: ts.Node | undefined): boolean {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node))
    && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
}

function knownVoidCallbackCall(call: ts.CallExpression): boolean {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return expression.text === 'setTimeout' || expression.text === 'setInterval';
  return ts.isPropertyAccessExpression(expression)
    && ['forEach', 'on', 'once', 'addEventListener'].includes(expression.name.text);
}

function location(sourceFile: ts.SourceFile, node: ts.Node): Pick<PolicyViolation, 'line' | 'column'> {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: point.line + 1, column: point.character + 1 };
}

function promiseViolations(
  repoRoot: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const path = normalizedPath(repoRoot, sourceFile.fileName);
  const add = (
    node: ts.Node,
    rule: PolicyViolation['rule'],
    message: string,
  ): void => {
    violations.push({ path, ...location(sourceFile, node), rule, message });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node)) {
      const expression = node.expression;
      const intentionallyDiscarded = ts.isVoidExpression(expression)
        || ts.isAwaitExpression(expression)
        || (ts.isBinaryExpression(expression)
          && expression.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && expression.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
;
      if (!intentionallyDiscarded && isThenable(checker.getTypeAtLocation(expression), checker)) {
        add(expression, 'floating-promise', 'Promise-valued expression must be awaited, returned, or explicitly discarded with void.');
      }
    }

    if (ts.isCallExpression(node) && knownVoidCallbackCall(node)) {
      for (const argument of node.arguments) {
        if (isAsyncFunction(argument)) {
          add(argument, 'misused-promise', 'Async callback is passed to an API that does not consume its returned Promise.');
        }
      }
    }

    const condition = ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)
      ? node.expression
      : ts.isConditionalExpression(node)
        ? node.condition
        : undefined;
    if (condition && isThenable(checker.getTypeAtLocation(condition), checker)) {
      add(condition, 'misused-promise', 'Promise-valued expression is used as a boolean condition.');
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export function loadTypeScriptProgram(repoRoot: string): ts.Program {
  const configPath = resolve(repoRoot, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot, undefined, configPath);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  }
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

export function lintTypeScriptFoundation(repoRoot: string): PolicyViolation[] {
  const program = loadTypeScriptProgram(repoRoot);
  const checker = program.getTypeChecker();
  const violations = program.getSourceFiles()
    .filter((sourceFile) => isFoundationProductionPath(repoRoot, sourceFile.fileName))
    .flatMap((sourceFile) => promiseViolations(repoRoot, sourceFile, checker));

  const baselinePath = resolve(repoRoot, 'scripts/toolchain/raw-child-process-baseline.json');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as RawChildProcessBaseline;
  const comparison = compareRawChildProcessBaseline(discoverRawChildProcessCalls(repoRoot), baseline);
  for (const call of comparison.added) {
    violations.push({
      path: call.path,
      line: 1,
      column: 1,
      rule: 'raw-child-process',
      message: `New raw ${call.api} call (${call.fingerprint}) must use scripts/kernel/subprocess.ts.`,
    });
  }
  for (const call of comparison.stale) {
    violations.push({
      path: call.path,
      line: 1,
      column: 1,
      rule: 'raw-child-process',
      message: `Grandfathered raw ${call.api} call (${call.fingerprint}) is stale; remove its baseline entry.`,
    });
  }
  return violations.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.rule.localeCompare(right.rule));
}

export function writeRawChildProcessBaseline(repoRoot: string): void {
  const path = resolve(repoRoot, 'scripts/toolchain/raw-child-process-baseline.json');
  const baseline = makeRawChildProcessBaseline(discoverRawChildProcessCalls(repoRoot));
  writeVersionOneBaseline(path, baseline.entries);
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  const repoRoot = process.cwd();
  if (process.argv.includes('--write-baseline')) {
    writeRawChildProcessBaseline(repoRoot);
    process.stdout.write('Wrote raw child-process baseline.\n');
  } else {
    const violations = lintTypeScriptFoundation(repoRoot);
    if (violations.length > 0) {
      for (const violation of violations) {
        process.stderr.write(`${violation.path}:${violation.line}:${violation.column} ${violation.rule}: ${violation.message}\n`);
      }
      process.exitCode = 1;
    } else {
      process.stdout.write('TypeScript foundation policy checks passed.\n');
    }
  }
}
