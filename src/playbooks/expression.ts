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
      const quote = ch;
      let str = '';
      i++;
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === '\\' && i + 1 < expr.length) {
          i++;
          str += expr[i];
        } else {
          str += expr[i];
        }
        i++;
      }
      if (i < expr.length && expr[i] === quote) {
        i++;
      }
      tokens.push({ type: 'literal', value: str, isQuoted: true });
      continue;
    }
    const two = expr.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '>=' || two === '<=' || two === '&&' || two === '||') {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    if (ch === '>' || ch === '<') {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    if (expr.slice(i, i + 3).toLowerCase() === 'and' && (i + 3 >= expr.length || /[\s()]/.test(expr[i + 3]))) {
      tokens.push({ type: 'op', value: '&&' });
      i += 3;
      continue;
    }
    if (expr.slice(i, i + 2).toLowerCase() === 'or' && (i + 2 >= expr.length || /[\s()]/.test(expr[i + 2]))) {
      tokens.push({ type: 'op', value: '||' });
      i += 2;
      continue;
    }
    if (expr.slice(i, i + 3).toLowerCase() === 'not' && (i + 3 >= expr.length || /[\s()]/.test(expr[i + 3]))) {
      tokens.push({ type: 'op', value: '!' });
      i += 3;
      continue;
    }
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
      throw new Error(`unexpected character "${ch}" in condition "${expr}"`);
    }
    tokens.push({ type: 'literal', value: expr.slice(i, end) });
    i = end;
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

function compare(left: string, right: string, op: string, leftQuoted?: boolean, rightQuoted?: boolean): boolean {
  if (leftQuoted || rightQuoted) {
    switch (op) {
      case '==':
        return left === right;
      case '!=':
        return left !== right;
      case '>':
        return left > right;
      case '<':
        return left < right;
      case '>=':
        return left >= right;
      case '<=':
        return left <= right;
      default:
        return false;
    }
  }
  const lNum = Number(left);
  const rNum = Number(right);
  const bothNumbers = !Number.isNaN(lNum) && !Number.isNaN(rNum) && left.trim() !== '' && right.trim() !== '';
  switch (op) {
    case '==':
      return bothNumbers ? lNum === rNum : left === right;
    case '!=':
      return bothNumbers ? lNum !== rNum : left !== right;
    case '>':
      return bothNumbers ? lNum > rNum : left > right;
    case '<':
      return bothNumbers ? lNum < rNum : left < right;
    case '>=':
      return bothNumbers ? lNum >= rNum : left >= right;
    case '<=':
      return bothNumbers ? lNum <= rNum : left <= right;
    default:
      return false;
  }
}
