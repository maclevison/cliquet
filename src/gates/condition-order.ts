import ts from 'typescript'

export interface ConditionOrderFinding {
  file: string
  line: number
  message: string
}

function isExpensive(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return isExpensive(node.expression)
  return ts.isCallExpression(node) || ts.isAwaitExpression(node)
}

function isCheap(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return isCheap(node.expression)
  if (ts.isPrefixUnaryExpression(node)) return isCheap(node.operand as ts.Expression)
  if (
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isLiteralExpression(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true
  }
  if (ts.isBinaryExpression(node) && COMPARISON_OPERATORS.includes(node.operatorToken.kind)) {
    return isCheap(node.left) && isCheap(node.right)
  }
  return false
}

const COMPARISON_OPERATORS = [
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
]

const LOGICAL = [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken]

// Swapping `a && b` / `a || b` operands only preserves meaning when the result is consumed
// as a boolean (a guard). In value position (`const x = f() || default`, `return f() || d`)
// the swap changes the returned value, so the finding is a false positive. Walk up parents,
// rebinding `node` at each level (the flagged node is the INNER logical, but the condition
// slot holds the OUTERMOST one), transparent through parens and enclosing &&/||.
function isInBooleanContext(node: ts.Expression): boolean {
  let current: ts.Node = node
  let parent = current.parent
  while (parent) {
    if (ts.isParenthesizedExpression(parent)) {
      current = parent
      parent = parent.parent
      continue
    }
    if (ts.isBinaryExpression(parent) && LOGICAL.includes(parent.operatorToken.kind)) {
      current = parent
      parent = parent.parent
      continue
    }
    if (ts.isPrefixUnaryExpression(parent)) {
      return parent.operator === ts.SyntaxKind.ExclamationToken
    }
    if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) {
      return parent.expression === current
    }
    if (ts.isForStatement(parent)) return parent.condition === current
    if (ts.isConditionalExpression(parent)) return parent.condition === current
    return false
  }
  return false
}

export function analyzeConditionOrder(filePath: string, content: string): ConditionOrderFinding[] {
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)
  const findings: ConditionOrderFinding[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && LOGICAL.includes(node.operatorToken.kind)) {
      if (isExpensive(node.left) && isCheap(node.right) && isInBooleanContext(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart())
        findings.push({
          file: filePath,
          line: line + 1,
          message: 'Expensive condition before cheap one — swap operands so the cheap check short-circuits',
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}
