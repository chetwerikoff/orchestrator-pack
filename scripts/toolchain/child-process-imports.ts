import ts from 'typescript';

export const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);

function moduleText(node: ts.Expression | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function unwrapExpression(node: ts.Expression | undefined): ts.Expression | undefined {
  let current = node;
  while (current && (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current))) {
    current = current.expression;
  }
  return current;
}

function isRequireCall(node: ts.Expression | undefined): node is ts.CallExpression {
  return !!node
    && ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'require';
}

function isImportCall(node: ts.Expression | undefined): node is ts.CallExpression {
  return !!node
    && ts.isCallExpression(node)
    && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

export function isChildProcessImport(node: ts.Expression | undefined): boolean {
  const expression = unwrapExpression(node);
  return (isRequireCall(expression) || isImportCall(expression))
    && CHILD_PROCESS_MODULES.has(moduleText(expression.arguments[0]) ?? '');
}
