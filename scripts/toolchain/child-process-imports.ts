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

export function recordChildProcessImportClause(
  importClause: ts.ImportClause | undefined,
  allowedApis: ReadonlySet<string>,
  named: Map<string, string>,
  namespaces: Set<string>,
): void {
  if (!importClause) return;
  if (importClause.name) namespaces.add(importClause.name.text);
  const bindings = importClause.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (allowedApis.has(imported)) named.set(element.name.text, imported);
    }
    return;
  }
  if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
}

export function recordChildProcessBindingName(
  name: ts.BindingName,
  sourceFile: ts.SourceFile,
  allowedApis: ReadonlySet<string>,
  named: Map<string, string>,
  namespaces: Set<string>,
): void {
  if (ts.isIdentifier(name)) {
    namespaces.add(name.text);
    return;
  }
  if (!ts.isObjectBindingPattern(name)) return;
  for (const element of name.elements) {
    const imported = element.propertyName && ts.isIdentifier(element.propertyName)
      ? element.propertyName.text
      : element.name.getText(sourceFile);
    const local = element.name.getText(sourceFile);
    if (allowedApis.has(imported)) named.set(local, imported);
  }
}
