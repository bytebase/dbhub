import { describe, it, expect } from 'vitest';
import { OracleConnector } from '../oracle/index.js';

describe('OracleConnector.splitStatements', () => {
  const split = OracleConnector.splitStatements;

  it('splits plain SQL on top-level semicolons and drops the terminators', () => {
    expect(split("INSERT INTO t VALUES (1); SELECT * FROM t;")).toEqual([
      'INSERT INTO t VALUES (1)',
      'SELECT * FROM t',
    ]);
  });

  it('keeps an anonymous block whole, semicolons included', () => {
    const block = 'BEGIN\n  UPDATE t SET x = 1;\n  DELETE FROM u;\nEND;';
    expect(split(block)).toEqual([block]);
  });

  it('keeps a PL/SQL block whole inside a mixed batch', () => {
    const block = 'BEGIN\n  UPDATE t SET x = 1;\nEND;';
    expect(split(`INSERT INTO t VALUES (1);\n${block}\nSELECT * FROM t`)).toEqual([
      'INSERT INTO t VALUES (1)',
      block,
      'SELECT * FROM t',
    ]);
  });

  it('handles DECLARE sections, nested blocks, IF/LOOP/CASE and exception handlers', () => {
    const block = [
      'DECLARE',
      '  n NUMBER := 0;',
      'BEGIN',
      '  FOR r IN (SELECT CASE WHEN x > 1 THEN 1 ELSE 0 END AS c FROM t) LOOP',
      '    IF r.c = 1 THEN n := n + 1; END IF;',
      '    CASE n WHEN 1 THEN NULL; ELSE NULL; END CASE;',
      '  END LOOP;',
      '  BEGIN',
      '    NULL;',
      '  EXCEPTION WHEN OTHERS THEN NULL;',
      '  END;',
      'END;',
    ].join('\n');
    expect(split(`${block}\nSELECT 1 FROM dual`)).toEqual([block, 'SELECT 1 FROM dual']);
  });

  it('keeps two routine definitions apart', () => {
    const fn = 'CREATE OR REPLACE FUNCTION f RETURN NUMBER IS\nBEGIN\n  RETURN 1;\nEND;';
    const proc = 'CREATE OR REPLACE PROCEDURE p(x OUT NUMBER) IS\nBEGIN\n  x := 1;\nEND;';
    expect(split(`${fn}\n/\n${proc}\n/`)).toEqual([fn, proc]);
    expect(split(`${fn}\n${proc}`)).toEqual([fn, proc]);
  });

  it('treats a package spec as one unit even though it has no BEGIN', () => {
    const pkg = 'CREATE PACKAGE pk IS\n  PROCEDURE a;\n  FUNCTION b RETURN NUMBER;\nEND pk;';
    expect(split(`${pkg}\nSELECT 1 FROM dual`)).toEqual([pkg, 'SELECT 1 FROM dual']);
  });

  it('ignores keywords and semicolons inside strings and comments', () => {
    const sql = "SELECT q'[begin; end;]' AS s, 'end' AS e FROM dual; -- begin\nSELECT 2 FROM dual";
    // A comment between statements is boundary noise, not part of the next statement.
    expect(split(sql)).toEqual([
      "SELECT q'[begin; end;]' AS s, 'end' AS e FROM dual",
      'SELECT 2 FROM dual',
    ]);
  });

  it('drops SQL*Plus slash terminator lines', () => {
    expect(split('SELECT 1 FROM dual;\n/\n')).toEqual(['SELECT 1 FROM dual']);
    expect(split('BEGIN NULL; END;\n/')).toEqual(['BEGIN NULL; END;']);
  });

  it('honours a slash line as the boundary of plain SQL with no semicolon', () => {
    expect(split('SELECT 1 FROM dual\n/\nSELECT 2 FROM dual')).toEqual([
      'SELECT 1 FROM dual',
      'SELECT 2 FROM dual',
    ]);
  });

  it('ignores empty statements from consecutive separators', () => {
    expect(split('SELECT 1 FROM dual;; SELECT 2 FROM dual;\n;\n')).toEqual([
      'SELECT 1 FROM dual',
      'SELECT 2 FROM dual',
    ]);
  });

  it('keeps a compound trigger whole through its section terminators', () => {
    const trigger = [
      'CREATE OR REPLACE TRIGGER audit_t',
      '  FOR INSERT OR UPDATE ON t',
      '  COMPOUND TRIGGER',
      '  n NUMBER := 0;',
      '  BEFORE STATEMENT IS',
      '  BEGIN',
      '    n := 0;',
      '  END BEFORE STATEMENT;',
      '  AFTER EACH ROW IS',
      '  BEGIN',
      '    n := n + 1;',
      '  END AFTER EACH ROW;',
      '  AFTER STATEMENT IS',
      '  BEGIN',
      '    NULL;',
      '  END AFTER STATEMENT;',
      'END audit_t;',
    ].join('\n');
    expect(split(`${trigger}\nSELECT 1 FROM dual`)).toEqual([trigger, 'SELECT 1 FROM dual']);
  });
});

describe('OracleConnector.bindsFor', () => {
  it('names each :N placeholder after parameters[N-1], once, in any order', () => {
    expect(OracleConnector.bindsFor('SELECT :2 AS a, :1 AS b, :1 AS c FROM dual', ['one', 'two'])).toEqual({
      '1': 'one',
      '2': 'two',
    });
  });

  it('includes only the placeholders the statement uses', () => {
    expect(OracleConnector.bindsFor('SELECT :2 FROM dual', ['one', 'two', 'three'])).toEqual({ '2': 'two' });
    expect(OracleConnector.bindsFor('SELECT 1 FROM dual', ['one'])).toEqual({});
  });

  it('ignores :N inside literals, comments and PostgreSQL-style casts', () => {
    expect(OracleConnector.bindsFor("SELECT q'[:1]' AS s, ':2' AS t, x::1 FROM dual -- :3", ['a', 'b', 'c'])).toEqual({});
  });
});

describe('OracleConnector.convertNumber', () => {
  it('returns safe integers as numbers, larger integers as BigInt, decimals as numbers', () => {
    expect(OracleConnector.convertNumber('42')).toBe(42);
    expect(OracleConnector.convertNumber('-7')).toBe(-7);
    expect(OracleConnector.convertNumber('9007199254740991')).toBe(9007199254740991);
    expect(OracleConnector.convertNumber('9007199254740993')).toBe(9007199254740993n);
    expect(OracleConnector.convertNumber('-12345678901234567890')).toBe(-12345678901234567890n);
    expect(OracleConnector.convertNumber('1.5')).toBe(1.5);
    expect(OracleConnector.convertNumber('1E+125')).toBe(1e125);
    expect(OracleConnector.convertNumber(null)).toBeNull();
  });
});
