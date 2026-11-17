import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import {
  buildSqliteDSN,
  normalizeSqliteDsn,
  parseSqliteDsnPath,
  resolveSqliteDsnPath,
  resolveSqliteFilePath,
} from '../sqlite-dsn.js';

describe('parseSqliteDsnPath', () => {
  it.each([
    ['sqlite:///path/to/database.db', '/path/to/database.db', 'absolute'],
    ['sqlite:///database.db', '/database.db', 'a single segment after three slashes is rooted'],
    ['sqlite:///.hidden/database.db', '/.hidden/database.db', 'a dot-directory after three slashes is rooted'],
    ['sqlite:////path/to/database.db', '/path/to/database.db', 'four-slash absolute'],
    ['sqlite://///server/share/database.db', '//server/share/database.db', 'UNC share'],
    ['sqlite:///C:/Users/test/database.db', 'C:/Users/test/database.db', 'Windows drive after three slashes'],
    ['sqlite://C:/Users/test/database.db', 'C:/Users/test/database.db', 'Windows drive after two slashes'],
    ['sqlite:///C:\\Users\\test\\database.db', 'C:\\Users\\test\\database.db', 'Windows drive with backslashes'],
    ['sqlite:///./relative/database.db', './relative/database.db', 'relative with ./ after three slashes'],
    ['sqlite:///../sibling/database.db', '../sibling/database.db', 'relative with ../ after three slashes'],
    ['sqlite://./relative/database.db', './relative/database.db', 'relative with ./ after two slashes'],
    ['sqlite://database.db', 'database.db', 'bare file name'],
    ['sqlite://data/database.db', 'data/database.db', 'bare relative path keeps its first directory'],
    ['sqlite:///~/databases/local.db', '~/databases/local.db', 'home directory after three slashes'],
    ['sqlite://~/databases/local.db', '~/databases/local.db', 'home directory after two slashes'],
    ['sqlite:///:memory:', ':memory:', 'in-memory'],
    ['sqlite://:memory:', ':memory:', 'in-memory after two slashes'],
    ['sqlite:///path/to/database.db?mode=ro', '/path/to/database.db', 'query string is not part of the path'],
  ])('reads %s as %s (%s)', (dsn, expected) => {
    expect(parseSqliteDsnPath(dsn)).toBe(expected);
  });

  it.each([['sqlite://'], ['sqlite:///'], ['sqlite://?mode=ro']])(
    'rejects %s, which names no file',
    (dsn) => {
      expect(() => parseSqliteDsnPath(dsn)).toThrow('does not name a database file');
    }
  );

  it('rejects a DSN for another database', () => {
    expect(() => parseSqliteDsnPath('postgres://localhost/db')).toThrow('not a SQLite DSN');
  });
});

describe('resolveSqliteFilePath', () => {
  const baseDir = path.resolve(os.tmpdir(), 'dbhub-base');

  it('resolves a relative path against the base directory', () => {
    expect(resolveSqliteFilePath('data/app.db', baseDir)).toBe(path.join(baseDir, 'data', 'app.db'));
    expect(resolveSqliteFilePath('./app.db', baseDir)).toBe(path.join(baseDir, 'app.db'));
    expect(resolveSqliteFilePath('../app.db', baseDir)).toBe(path.join(path.dirname(baseDir), 'app.db'));
  });

  it('defaults the base directory to the working directory', () => {
    expect(resolveSqliteFilePath('app.db')).toBe(path.resolve(process.cwd(), 'app.db'));
  });

  it('expands ~/ to the home directory', () => {
    expect(resolveSqliteFilePath('~/databases/local.db', baseDir)).toBe(
      path.join(os.homedir(), 'databases', 'local.db')
    );
  });

  it('leaves an absolute path, a drive-letter path and :memory: untouched', () => {
    const absolute = path.join(baseDir, 'elsewhere.db');
    expect(resolveSqliteFilePath(absolute, '/somewhere/else')).toBe(absolute);
    expect(resolveSqliteFilePath('C:/Data/app.db', baseDir)).toBe('C:/Data/app.db');
    expect(resolveSqliteFilePath(':memory:', baseDir)).toBe(':memory:');
  });
});

describe('resolveSqliteDsnPath', () => {
  const baseDir = path.resolve(os.tmpdir(), 'dbhub-base');

  // Every one of these used to open a file at the filesystem root (or a
  // throwaway temporary database) instead of the file next to the caller.
  it.each([
    ['sqlite:///./shop.db', 'shop.db'],
    ['sqlite://./shop.db', 'shop.db'],
    ['sqlite://shop.db', 'shop.db'],
    ['sqlite://data/shop.db', path.join('data', 'shop.db')],
  ])('resolves %s inside the base directory', (dsn, relative) => {
    expect(resolveSqliteDsnPath(dsn, baseDir)).toBe(path.join(baseDir, relative));
  });

  it('keeps a four-slash path absolute rather than relative', () => {
    expect(resolveSqliteDsnPath('sqlite:////var/lib/app.db', baseDir)).toBe('/var/lib/app.db');
  });

  it('keeps a three-slash path rooted', () => {
    expect(resolveSqliteDsnPath('sqlite:///shop.db', baseDir)).toBe('/shop.db');
  });
});

describe('buildSqliteDSN', () => {
  it.each([
    ['/var/lib/app/data.db', 'sqlite:///var/lib/app/data.db'],
    ['C:/Data/app/data.db', 'sqlite:///C:/Data/app/data.db'],
    ['//server/share/data.db', 'sqlite://///server/share/data.db'],
    [':memory:', 'sqlite:///:memory:'],
  ])('encodes %s as %s and decodes it back', (database, dsn) => {
    expect(buildSqliteDSN(database)).toBe(dsn);
    expect(parseSqliteDsnPath(dsn)).toBe(database);
  });
});

describe('normalizeSqliteDsn', () => {
  const baseDir = path.resolve(os.tmpdir(), 'dbhub-base');

  it('rewrites a relative DSN to an absolute one', () => {
    const normalized = normalizeSqliteDsn('sqlite:///./shop.db', baseDir);
    expect(normalized).toBe(buildSqliteDSN(path.join(baseDir, 'shop.db')));
    expect(resolveSqliteDsnPath(normalized, '/somewhere/else')).toBe(path.join(baseDir, 'shop.db'));
  });

  it('leaves absolute and in-memory DSNs as they are', () => {
    expect(normalizeSqliteDsn('sqlite:///var/lib/app.db', baseDir)).toBe('sqlite:///var/lib/app.db');
    expect(normalizeSqliteDsn('sqlite:///:memory:', baseDir)).toBe('sqlite:///:memory:');
  });

  it('keeps the query string', () => {
    expect(normalizeSqliteDsn('sqlite://shop.db?mode=ro', baseDir)).toBe(
      `${buildSqliteDSN(path.join(baseDir, 'shop.db'))}?mode=ro`
    );
  });
});
