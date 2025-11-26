import { describe, it, expect } from 'vitest';
import { normalizeSourceId } from '../normalize-id.js';

describe('normalizeSourceId', () => {
  it('should keep alphanumeric characters unchanged', () => {
    expect(normalizeSourceId('prod_db')).toBe('prod_db');
    expect(normalizeSourceId('database123')).toBe('database123');
    expect(normalizeSourceId('DB2024')).toBe('DB2024');
  });

  it('should convert hyphens to underscores', () => {
    expect(normalizeSourceId('staging-db')).toBe('staging_db');
    expect(normalizeSourceId('my-production-database')).toBe('my_production_database');
  });

  it('should convert dots to underscores', () => {
    expect(normalizeSourceId('dev.db')).toBe('dev_db');
    expect(normalizeSourceId('prod.mysql.instance')).toBe('prod_mysql_instance');
  });

  it('should convert multiple special characters', () => {
    expect(normalizeSourceId('my@db#123')).toBe('my_db_123');
    expect(normalizeSourceId('test!db$xyz%')).toBe('test_db_xyz_');
  });

  it('should convert spaces to underscores', () => {
    expect(normalizeSourceId('production database')).toBe('production_database');
    expect(normalizeSourceId('my db 2024')).toBe('my_db_2024');
  });

  it('should handle consecutive special characters', () => {
    expect(normalizeSourceId('prod--db')).toBe('prod__db');
    expect(normalizeSourceId('test...db')).toBe('test___db');
  });

  it('should handle edge cases', () => {
    expect(normalizeSourceId('')).toBe('');
    expect(normalizeSourceId('a')).toBe('a');
    expect(normalizeSourceId('_')).toBe('_');
    expect(normalizeSourceId('123')).toBe('123');
  });

  it('should handle unicode and special symbols', () => {
    expect(normalizeSourceId('db-é-test')).toBe('db___test');
    expect(normalizeSourceId('production™')).toBe('production_');
    expect(normalizeSourceId('test★db')).toBe('test_db');
  });

  it('should work with real-world source IDs', () => {
    expect(normalizeSourceId('prod-postgres-001')).toBe('prod_postgres_001');
    expect(normalizeSourceId('staging.mysql.v2')).toBe('staging_mysql_v2');
    expect(normalizeSourceId('dev_sqlite_local')).toBe('dev_sqlite_local');
  });
});
