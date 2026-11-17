import { describe, it, expect } from 'vitest';
import { toolsAreReadOnly } from '../builtin-tools.js';

describe('toolsAreReadOnly', () => {
  const source = 'shop';

  it.each([
    ['execute_sql with readonly = true', [{ name: 'execute_sql', source, readonly: true }]],
    [
      'read-only execute_sql alongside search_objects',
      [{ name: 'execute_sql', source, readonly: true }, { name: 'search_objects', source }],
    ],
    ['search_objects only', [{ name: 'search_objects', source }]],
    [
      'the opt-in built-ins, which never write',
      [{ name: 'explain_sql', source }, { name: 'health_check', source }],
    ],
    [
      'a custom tool with readonly = true',
      [{ name: 'top_customers', source, readonly: true }],
    ],
  ])('is true for %s', (_label, tools) => {
    expect(toolsAreReadOnly(source, tools)).toBe(true);
  });

  it.each([
    ['no tools at all (the default execute_sql is writable)', []],
    ['undefined tools', undefined],
    ['execute_sql without readonly', [{ name: 'execute_sql', source }]],
    ['execute_sql with readonly = false', [{ name: 'execute_sql', source, readonly: false }]],
    [
      'a custom tool without readonly next to a read-only execute_sql',
      [{ name: 'execute_sql', source, readonly: true }, { name: 'archive_orders', source }],
    ],
    [
      'tools that all belong to another source',
      [{ name: 'execute_sql', source: 'other', readonly: true }],
    ],
  ])('is false for %s', (_label, tools) => {
    expect(toolsAreReadOnly(source, tools)).toBe(false);
  });

  it('judges each source by its own tools', () => {
    const tools = [
      { name: 'execute_sql', source: 'shop', readonly: true },
      { name: 'execute_sql', source: 'scratch' },
    ];

    expect(toolsAreReadOnly('shop', tools)).toBe(true);
    expect(toolsAreReadOnly('scratch', tools)).toBe(false);
  });
});
