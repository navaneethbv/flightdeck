import { describe, it, expect } from 'vitest';
import { evaluateExpression } from '../../src/playbooks/expression.js';

describe('evaluateExpression', () => {
  it('compares numbers and strings', () => {
    expect(evaluateExpression('200 == 200')).toBe(true);
    expect(evaluateExpression('1 > 2')).toBe(false);
    expect(evaluateExpression('3 >= 3')).toBe(true);
    expect(evaluateExpression('a == a')).toBe(true);
    expect(evaluateExpression('a != b')).toBe(true);
    expect(evaluateExpression('true')).toBe(true);
    expect(evaluateExpression('false')).toBe(false);
  });

  it('supports logical operators and parentheses', () => {
    expect(evaluateExpression('1 == 1 and 2 == 2')).toBe(true);
    expect(evaluateExpression('1 == 1 or 1 == 2')).toBe(true);
    expect(evaluateExpression('not false')).toBe(true);
    expect(evaluateExpression('(1 == 1) and (2 == 3 or 4 == 4)')).toBe(true);
  });

  it('supports quoted strings with whitespace and escape characters', () => {
    expect(evaluateExpression('"hello world" == "hello world"')).toBe(true);
    expect(evaluateExpression("'agent test' != 'other test'")).toBe(true);
    expect(evaluateExpression('"status: ok" == "status: ok" && true')).toBe(true);
  });
});
