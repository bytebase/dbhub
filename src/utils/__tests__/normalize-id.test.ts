import { describe, it, expect } from 'vitest';
import { normalizeSourceId } from '../normalize-id.js';

describe('normalizeSourceId', () => {
  it.each([
    // Letters, digits and underscores are kept as they are
    ['prod_db', 'prod_db'],
    ['database123', 'database123'],
    ['DB2024', 'DB2024'],
    ['_', '_'],
    ['', ''],
    // Every other character becomes an underscore, one for one
    ['staging-db', 'staging_db'],
    ['my-production-database', 'my_production_database'],
    ['prod.mysql.instance', 'prod_mysql_instance'],
    ['my db 2024', 'my_db_2024'],
    ['my@db#123', 'my_db_123'],
    ['test!db$xyz%', 'test_db_xyz_'],
    // ... so consecutive ones are not collapsed
    ['prod--db', 'prod__db'],
    ['test...db', 'test___db'],
    // Non-ASCII letters and symbols count as "other" too
    ['db-é-test', 'db___test'],
    ['production™', 'production_'],
    ['test★db', 'test_db'],
  ])('should normalize %j to %j', (id, expected) => {
    expect(normalizeSourceId(id)).toBe(expected);
  });
});
