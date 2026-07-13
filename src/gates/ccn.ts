import ts from 'typescript'

export interface FunctionComplexity {
  file: string
  line: number
  name: string
  ccn: number
}

const FUNCTION_KINDS = [
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]

function isFunctionNode(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return FUNCTION_KINDS.includes(node.kind)
}

export function measureFileComplexity(filePath: string, content: string): FunctionComplexity[] {
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind(filePath))
  const results: FunctionComplexity[] = []

  const visit = (node: ts.Node): void => {
    if (isFunctionNode(node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart())
      results.push({
        file: filePath,
        line: line + 1,
        name: functionName(node),
        ccn: 1 + countDecisionPoints(node),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return results
}

function scriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function functionName(node: ts.FunctionLikeDeclaration): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
    return node.name.getText()
  }
  if (ts.isConstructorDeclaration(node)) return 'constructor'
  // arrow/function expression: try the name of the variable it's assigned to
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  return '<anonymous>'
}

const LOGICAL_OPERATORS = [
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]

function countDecisionPoints(fn: ts.Node): number {
  let count = 0
  const visit = (node: ts.Node): void => {
    if (node !== fn && isFunctionNode(node)) return // nested function counts separately
    if (
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isCaseClause(node) ||
      ts.isCatchClause(node) ||
      ts.isConditionalExpression(node)
    ) {
      count++
    }
    if (ts.isBinaryExpression(node) && LOGICAL_OPERATORS.includes(node.operatorToken.kind)) {
      count++
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(fn, visit)
  return count
}
