import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('CWE-346 CORS fix in server.ts', () => {
  const src = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');

  it('does not reflect Origin header back into Access-Control-Allow-Origin', () => {
    expect(src).not.toMatch(/Access-Control-Allow-Origin['"]\s*,\s*origin\b/);
  });

  it('uses a static wildcard for Access-Control-Allow-Origin', () => {
    expect(src).toMatch(/Access-Control-Allow-Origin['"]\s*,\s*['"]\*['"]/);
  });

  it('does not enable Access-Control-Allow-Credentials', () => {
    expect(src).not.toMatch(/Access-Control-Allow-Credentials/);
  });

  it('includes a DNS-rebinding Origin/Host check', () => {
    expect(src).toMatch(/DNS rebinding protection/i);
  });
});
