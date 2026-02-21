import { describe, it, expect, vi } from 'vitest';
import { createGenerateCodeToolHandler } from '../generate-code-handler.js';

describe('generate-code tool', () => {
  it('should generate code for a simple SQL SELECT query', async () => {
    const handler = createGenerateCodeToolHandler();
    const result = await handler({
      query_type: 'sql',
      query: 'SELECT id, name FROM users WHERE id = 1',
      database_type: 'postgres',
      language: 'both',
      orm_preference: 'all'
    }, null);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('# Generated Code Conversion');
    expect(result.content[0].text).toContain('## C# Implementation');
    expect(result.content[0].text).toContain('## TypeScript Implementation');
    expect(result.content[0].text).toContain('context.users');
    expect(result.content[0].text).toContain('prisma.users.findMany');
  });

  it('should generate code for Redis GET command', async () => {
    const handler = createGenerateCodeToolHandler();
    const result = await handler({
      query_type: 'redis',
      query: 'GET mykey',
      database_type: 'redis',
      language: 'typescript'
    }, null);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('const value = await redis.get("mykey")');
  });

  it('should handle invalid input', async () => {
    const handler = createGenerateCodeToolHandler();
    const result = await handler({
      query_type: 'invalid',
      query: 'some query'
    }, null);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error generating code');
  });
});
