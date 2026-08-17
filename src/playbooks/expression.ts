export function evaluateExpression(expr: string): boolean {
  const tokens = tokenize(expr);
  const parser = new Parser(tokens);
  const value = parser.parseOr();
  return truthy(value);
}

function truthy(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === '') return false;
  const num = Number(value);
  if (!Number.isNaN(num)) return num !== 0;
  return true;
}

interface Token {
  type: 'literal' | 'op' | 'paren';
  value: string;
  isQuoted?: boolean;
}

function readQuotedString(expr: string, i: number): { token: Token; nextI: number } {
  const quote = expr[i];
  let str = '';
  let idx = i + 1;
  while (idx < expr.length && expr[idx] !== quote) {
    if (expr[idx] === '\\' && idx + 1 < expr.length) {
      idx++;
      str += expr[idx];
    } else {
      str += expr[idx];
    }
    idx++;
  }
  if (idx < expr.length && expr[idx] === quote) {
    idx++;
  }
  return { token: { type: 'literal', value: str, isQuoted: true }, nextI: idx };
}

function readOperator(expr: string, i: number): { token: Token; nextI: number } | null {
  const two = expr.slice(i, i + 2);
  if (two === '==' || two === '!=' || two === '>=' || two === '<=' || two === '&&' || two === '||') {
    return { token: { type: 'op', value: two }, nextI: i + 2 };
  }
  const ch = expr[i];
  if (ch === '>' || ch === '<' || ch === '!') {
    return { token: { type: 'op', value: ch }, nextI: i + 1 };
  }
  if (expr.slice(i, i + 3).toLowerCase() === 'and' && (i + 3 >= expr.length || /[\s()]/.test(expr[i + 3]))) {
    return { token: { type: 'op', value: '&&' }, nextI: i + 3 };
  }
  if (expr.slice(i, i + 2).toLowerCase() === 'or' && (i + 2 >= expr.length || /[\s()]/.test(expr[i + 2]))) {
    return { token: { type: 'op', value: '||' }, nextI: i + 2 };
  }
  if (expr.slice(i, i + 3).toLowerCase() === 'not' && (i + 3 >= expr.length || /[\s()]/.test(expr[i + 3]))) {
    return { token: { type: 'op', value: '!' }, nextI: i + 3 };
  }
  return null;
}

function readLiteral(expr: string, i: number): { token: Token; nextI: number } {
  let end = i;
  while (
    end < expr.length &&
    !/[\s()=!<>"']/.test(expr[end]) &&
    expr.slice(end, end + 2) !== '&&' &&
    expr.slice(end, end + 2) !== '||'
  ) {
    end++;
  }
  if (end === i) {
    throw new Error(`unexpected character "${expr[i]}" in condition "${expr}"`);
  }
  return { token: { type: 'literal', value: expr.slice(i, end) }, nextI: end };
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const res = readQuotedString(expr, i);
      tokens.push(res.token);
      i = res.nextI;
      continue;
    }
    const op = readOperator(expr, i);
    if (op) {
      tokens.push(op.token);
      i = op.nextI;
      continue;
    }
    const lit = readLiteral(expr, i);
    tokens.push(lit.token);
    i = lit.nextI;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  parseOr(): string {
    let left = this.parseAnd();
    while (this.peek()?.value === '||') {
      this.next();
      const right = this.parseAnd();
      left = String(truthy(left) || truthy(right));
    }
    return left;
  }

  private parseAnd(): string {
    const left = this.parseComparison();
    let acc = left;
    while (this.peek()?.value === '&&') {
      this.next();
      const right = this.parseComparison();
      acc = String(truthy(acc) && truthy(right));
    }
    return acc;
  }

  private parseComparison(): string {
    const leftToken = this.peek();
    const left = this.parseUnary();
    const opToken = this.peek();
    if (
      opToken?.value === '==' ||
      opToken?.value === '!=' ||
      opToken?.value === '>' ||
      opToken?.value === '<' ||
      opToken?.value === '>=' ||
      opToken?.value === '<='
    ) {
      const op = this.next()!.value;
      const rightToken = this.peek();
      const right = this.parseUnary();
      return String(compare(left, right, op, leftToken?.isQuoted, rightToken?.isQuoted));
    }
    return left;
  }

  private parseUnary(): string {
    if (this.peek()?.value === '!') {
      this.next();
      const value = this.parseUnary();
      return String(!truthy(value));
    }
    return this.parsePrimary();
  }

  private parsePrimary(): string {
    const token = this.next();
    if (token === undefined) throw new Error('unexpected end of condition');
    if (token.value === '(') {
      const inner = this.parseOr();
      const nextToken = this.next();
      if (nextToken?.value !== ')') throw new Error('missing closing parenthesis in condition');
      return inner;
    }
    return token.value;
  }
}

function compareValues(a: string | number, b: string | number, op: string): boolean {
  switch (op) {
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '>':
      return a > b;
    case '<':
      return a < b;
    case '>=':
      return a >= b;
    case '<=':
      return a <= b;
    default:
      return false;
  }
}

function compare(left: string, right: string, op: string, leftQuoted?: boolean, rightQuoted?: boolean): boolean {
  if (leftQuoted || rightQuoted) {
    return compareValues(left, right, op);
  }
  const lNum = Number(left);
  const rNum = Number(right);
  const bothNumbers = !Number.isNaN(lNum) && !Number.isNaN(rNum) && left.trim() !== '' && right.trim() !== '';
  return bothNumbers ? compareValues(lNum, rNum, op) : compareValues(left, right, op);
}
