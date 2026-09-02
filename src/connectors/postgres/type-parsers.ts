import pg from "pg";

/**
 * PostgreSQL type OIDs whose values DBHub returns as the server's verbatim
 * text instead of letting node-postgres convert them to JavaScript Dates.
 *
 * pg-types parses `timestamp without time zone` and `date` with the
 * multi-argument Date constructor, i.e. in the DBHub host's local timezone.
 * The JSON serializer then renders that Date via toISOString(), so a stored
 * wall-clock value of `2026-01-01 12:00:00` comes back as
 * `2026-01-01T18:00:00.000Z` on a host running in America/Chicago: the host
 * offset is baked into the output, a `Z` suffix makes it look authoritative,
 * and sub-millisecond precision is dropped. `timestamptz` is parsed via
 * Date.UTC and so was never shifted, but it is included here so all three
 * date/time types render consistently as the text psql would show.
 *
 * See https://github.com/bytebase/dbhub/issues/416
 */
export const VERBATIM_DATE_TIME_OIDS: ReadonlySet<number> = new Set([
  1082, // date
  1114, // timestamp without time zone
  1184, // timestamp with time zone
  1182, // date[]
  1115, // timestamp[]
  1185, // timestamptz[]
]);

const passthrough = (value: string): string => value;

/**
 * Type parser configuration for the connection pool. Scoped to DBHub's pool
 * via `PoolConfig.types` rather than mutating the process-wide `pg.types`
 * registry, so other consumers of node-postgres in the same process keep the
 * default behavior.
 */
export const postgresTypeParsers: pg.CustomTypesConfig = {
  getTypeParser(oid: number, format?: "text" | "binary"): any {
    if (VERBATIM_DATE_TIME_OIDS.has(oid) && (format === undefined || format === "text")) {
      return passthrough;
    }
    return pg.types.getTypeParser(oid, format as any);
  },
};
