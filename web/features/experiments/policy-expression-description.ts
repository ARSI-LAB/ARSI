import {
  compileExpression,
  expressions,
  type ExpressionAst,
} from '../../../src/runtime/policy/expression-syntax.js';

interface PolicyExpressionOperand {
  label: string;
  description: PolicyExpressionDescription;
}

export interface PolicyExpressionDescription {
  text: string;
  operands?: readonly PolicyExpressionOperand[];
}

type DescribeOperand = (
  value: ExpressionAst,
  label: string,
  placeholder?: string,
) => string;

function formatPath(parts: string[]): string {
  const [root, ...properties] = parts;
  return (
    root +
    properties
      .map((part) => {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) return `.${part}`;
        const numeric =
          /^(?:0|[1-9]\d*)$/.test(part) && Number.isSafeInteger(Number(part));
        return `[${numeric ? part : JSON.stringify(part)}]`;
      })
      .join('')
  );
}

const listFormat = new Intl.ListFormat('en');

function concatenatedLists(value: ExpressionAst): ExpressionAst[] {
  return value.kind === 'call' && value.name === 'concat'
    ? value.args.flatMap(concatenatedLists)
    : [value];
}

function formatCall(
  call: Extract<ExpressionAst, { kind: 'call' }>,
  operand: DescribeOperand,
): string {
  const [first, second, third] = call.args;
  switch (call.name) {
    case 'append': {
      const list = operand(first!, 'List');
      const item = operand(second!, 'Item');
      return `Add ${item} to the end of ${list}`;
    }
    case 'concat': {
      const lists = concatenatedLists(call).map((list, index) =>
        operand(list, `List ${index + 1}`, `list ${index + 1} below`),
      );
      return `Join ${listFormat.format(lists)} in order`;
    }
    case 'range': {
      const start = operand(first!, 'Start', 'the start value below');
      const end = operand(second!, 'End (excluded)', 'the end value below');
      return `Start at ${start}, stop before ${end}`;
    }
    case 'length':
    case 'size':
      return `Count the items in ${operand(first!, 'List')}`;
    case 'flatten':
      return `Join the lists inside ${operand(first!, 'List')} in order`;
    case 'compact':
      return `Remove null entries from ${operand(first!, 'List')}`;
    case 'get': {
      const source = operand(first!, 'Source');
      const key = operand(second!, 'Key or index');
      const fallback = operand(third!, 'Fallback');
      return `Read ${key} from ${source}, or use ${fallback} if it is missing`;
    }
    case 'pluck': {
      const list = operand(first!, 'List');
      const key = operand(second!, 'Key or index');
      return `Read ${key} from each item in ${list}`;
    }
    case 'some': {
      const list = operand(first!, 'List');
      const key = operand(second!, 'Key or index');
      const value = operand(third!, 'Expected value');
      return `Check whether any item in ${list} has ${key} equal to ${value}`;
    }
    case 'if': {
      const condition = operand(first!, 'Condition');
      const yes = operand(second!, 'True result');
      const no = operand(third!, 'False result');
      return `If ${condition}, use ${yes}, otherwise use ${no}`;
    }
  }
}

function formatExpression(ast: ExpressionAst): {
  description: PolicyExpressionDescription;
  hasCall: boolean;
} {
  if (ast.kind === 'literal' || ast.kind === 'path') {
    return {
      description: {
        text:
          ast.kind === 'literal'
            ? JSON.stringify(ast.value)
            : formatPath(ast.parts),
      },
      hasCall: false,
    };
  }

  const operands: PolicyExpressionOperand[] = [];
  let hasCall = false;
  function operand(
    value: ExpressionAst,
    label: string,
    placeholder = `the ${label.toLowerCase()} below`,
  ): string {
    const formatted = formatExpression(value);
    hasCall ||= formatted.hasCall;
    const { description } = formatted;
    if (value.kind !== 'call' && !description.operands?.length)
      return description.text;
    operands.push({ label, description });
    return placeholder;
  }

  let text: string;
  switch (ast.kind) {
    case 'call':
      text = formatCall(ast, operand);
      hasCall = true;
      break;
    case 'binary': {
      const left = operand(ast.left, 'Left operand', 'left operand below');
      const right = operand(ast.right, 'Right operand', 'right operand below');
      text = `(${left} ${ast.operator} ${right})`;
      break;
    }
    case 'unary': {
      const value = operand(ast.operand, 'Operand', '(operand below)');
      text = `${ast.operator}${value}`;
      break;
    }
    case 'access': {
      const object = operand(ast.object, 'Source', '(source below)');
      const key = operand(ast.key, 'Key or index', 'key or index below');
      const base = ast.object.kind === 'unary' ? `(${object})` : object;
      text = `${base}[${key}]`;
      break;
    }
  }

  return {
    description: operands.length ? { text, operands } : { text },
    hasCall,
  };
}

export function describePolicyExpression(
  value: string,
  additionalRoots: readonly string[] = [],
): PolicyExpressionDescription | undefined {
  let ast: ExpressionAst;
  try {
    const [source] = expressions(value);
    if (source === undefined) return undefined;
    ast = compileExpression(source, additionalRoots);
  } catch {
    return undefined;
  }

  const { description, hasCall } = formatExpression(ast);
  return hasCall ? description : undefined;
}
