import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { postgresTypeParsers, VERBATIM_DATE_TIME_OIDS } from '../postgres/type-parsers.js';

const OID_DATE = 1082;
const OID_TIMESTAMP = 1114;
const OID_TIMESTAMPTZ = 1184;
const OID_TIME = 1083;
const OID_INT4 = 23;
const OID_TIMESTAMP_ARRAY = 1115;

// Regression test for https://github.com/bytebase/dbhub/issues/416:
// `timestamp without time zone` and `date` values were parsed into JavaScript
// Dates in the host's local timezone, so the JSON output was shifted by the
// host's UTC offset. The parsers below are pure functions, so the behavior can
// be checked without a database.
describe('PostgreSQL date/time type parsers', () => {
  it('returns timestamp without time zone verbatim, including microseconds', () => {
    const parse = postgresTypeParsers.getTypeParser(OID_TIMESTAMP, 'text');
    expect(parse('2026-01-01 12:00:00')).toBe('2026-01-01 12:00:00');
    expect(parse('2026-01-01 12:00:00.123456')).toBe('2026-01-01 12:00:00.123456');
  });

  it('returns date verbatim instead of a host-local midnight instant', () => {
    const parse = postgresTypeParsers.getTypeParser(OID_DATE, 'text');
    expect(parse('2026-01-01')).toBe('2026-01-01');
  });

  it('returns timestamp with time zone verbatim, preserving the session offset', () => {
    const parse = postgresTypeParsers.getTypeParser(OID_TIMESTAMPTZ, 'text');
    expect(parse('2026-01-01 12:00:00+00')).toBe('2026-01-01 12:00:00+00');
  });

  it('returns array element text verbatim for timestamp[]', () => {
    const parse = postgresTypeParsers.getTypeParser(OID_TIMESTAMP_ARRAY, 'text');
    expect(parse('{"2026-01-01 12:00:00"}')).toBe('{"2026-01-01 12:00:00"}');
  });

  it('is independent of the host timezone', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'America/Chicago';
    try {
      const parse = postgresTypeParsers.getTypeParser(OID_TIMESTAMP, 'text');
      // JSON.stringify is what the response formatter applies to row values.
      expect(JSON.stringify(parse('2026-01-01 12:00:00'))).toBe('"2026-01-01 12:00:00"');
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('defaults to the text format when none is given', () => {
    const parse = postgresTypeParsers.getTypeParser(OID_TIMESTAMP);
    expect(parse('2026-01-01 12:00:00')).toBe('2026-01-01 12:00:00');
  });

  it('delegates every other type to the default pg-types parsers', () => {
    expect(postgresTypeParsers.getTypeParser(OID_INT4, 'text')('42')).toBe(42);
    expect(postgresTypeParsers.getTypeParser(OID_TIME, 'text')('12:00:00.123456')).toBe('12:00:00.123456');
    expect(postgresTypeParsers.getTypeParser(OID_INT4, 'binary')).toBe(pg.types.getTypeParser(OID_INT4, 'binary'));
  });

  it('does not mutate the process-wide pg.types registry', () => {
    for (const oid of VERBATIM_DATE_TIME_OIDS) {
      expect(pg.types.getTypeParser(oid, 'text')).not.toBe(postgresTypeParsers.getTypeParser(oid, 'text'));
    }
    expect(pg.types.getTypeParser(OID_TIMESTAMP, 'text')('2026-01-01 12:00:00')).toBeInstanceOf(Date);
  });
});
