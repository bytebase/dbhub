import { describe, it, expect } from "vitest";
import { parseQueryResultSets } from "../multi-statement-result-parser.js";

/** mysql2 FieldPacket shape. */
const mysqlField = (name: string) => ({ name });
/** mariadb ColumnDefinition shape: the name is behind a method. */
const mariadbColumn = (name: string) => ({ name: () => name });

describe("parseQueryResultSets", () => {
  describe("array row mode (rowsAsArray)", () => {
    it("rebuilds a single result set from positional rows and its fields", () => {
      const sets = parseQueryResultSets([[1, "x"], [2, "y"]], ["SELECT id, name FROM t"], [
        mysqlField("id"),
        mysqlField("name"),
      ]);
      expect(sets).toEqual([
        { sql: "SELECT id, name FROM t", rows: [{ id: 1, name: "x" }, { id: 2, name: "y" }], rowCount: 2 },
      ]);
    });

    it("keeps every column of a result with repeated names", () => {
      const sets = parseQueryResultSets([[10, 3]], ["SELECT COUNT(*), COUNT(*) FROM t"], [
        mysqlField("COUNT(*)"),
        mysqlField("COUNT(*)"),
      ]);
      expect(sets[0].rows).toEqual([{ "COUNT(*)": 10, "COUNT(*)_1": 3 }]);
    });

    it("reads mariadb column names through their name() method", () => {
      const sets = parseQueryResultSets([[1, 2]], ["SELECT 1 AS a, 2 AS a"], [
        mariadbColumn("a"),
        mariadbColumn("a"),
      ]);
      expect(sets[0].rows).toEqual([{ a: 1, a_1: 2 }]);
    });

    it("does not mistake a single statement's positional rows for a batch", () => {
      // Without fields, a leading array could only mean a per-statement row
      // list; with a flat field list it is the first row of one result set.
      const sets = parseQueryResultSets([[1], [2], [3]], ["SELECT id FROM t"], [mysqlField("id")]);
      expect(sets).toHaveLength(1);
      expect(sets[0].rowCount).toBe(3);
    });

    it("pairs each statement of a batch with its own fields (mysql2: undefined for writes)", () => {
      const results = [
        { affectedRows: 1, insertId: 7 },
        [[7, "x"]],
        [[1, 1]],
      ];
      const fields = [undefined, [mysqlField("id"), mysqlField("name")], [mysqlField("a"), mysqlField("a")]];
      const statements = ["INSERT INTO t VALUES (7, 'x')", "SELECT id, name FROM t", "SELECT 1 AS a, 1 AS a"];
      expect(parseQueryResultSets(results, statements, fields)).toEqual([
        { sql: statements[0], rows: [], rowCount: 1 },
        { sql: statements[1], rows: [{ id: 7, name: "x" }], rowCount: 1 },
        { sql: statements[2], rows: [{ a: 1, a_1: 1 }], rowCount: 1 },
      ]);
    });

    it("pairs each statement of a batch with its own meta (mariadb: null for writes)", () => {
      const results = [[[1]], { affectedRows: 2, warningStatus: 0 }];
      const meta = [[mariadbColumn("x")], null];
      expect(parseQueryResultSets(results, ["SELECT 1 AS x", "UPDATE t SET a = 1"], meta)).toEqual([
        { sql: "SELECT 1 AS x", rows: [{ x: 1 }], rowCount: 1 },
        { sql: "UPDATE t SET a = 1", rows: [], rowCount: 2 },
      ]);
    });

    it("treats a batch of only writes as a batch", () => {
      const results = [{ affectedRows: 1 }, { affectedRows: 1 }];
      expect(parseQueryResultSets(results, ["INSERT 1", "INSERT 2"], [undefined, undefined])).toEqual([
        { sql: "INSERT 1", rows: [], rowCount: 1 },
        { sql: "INSERT 2", rows: [], rowCount: 1 },
      ]);
    });
  });

  describe("object rows (no fields, or rows already keyed by name)", () => {
    it("passes object rows through unchanged", () => {
      const rows = [{ id: 1 }];
      const sets = parseQueryResultSets(rows, ["SELECT id FROM t"]);
      expect(sets).toEqual([{ sql: "SELECT id FROM t", rows, rowCount: 1 }]);
    });

    it("passes object rows through when the fields list is empty", () => {
      const rows = [{ id: 1 }];
      expect(parseQueryResultSets(rows, ["SELECT id FROM t"], [])[0].rows).toBe(rows);
    });

    it("still reads a batch of row lists without fields as a batch", () => {
      const sets = parseQueryResultSets([[{ a: 1 }], [{ b: 2 }]], ["SELECT 1 AS a", "SELECT 2 AS b"]);
      expect(sets).toEqual([
        { sql: "SELECT 1 AS a", rows: [{ a: 1 }], rowCount: 1 },
        { sql: "SELECT 2 AS b", rows: [{ b: 2 }], rowCount: 1 },
      ]);
    });

    it("maps a lone write result to an empty set with its affected-row count", () => {
      expect(parseQueryResultSets({ affectedRows: 3, insertId: 0 }, ["DELETE FROM t"])).toEqual([
        { sql: "DELETE FROM t", rows: [], rowCount: 3 },
      ]);
    });

    it("attributes statement text only when the counts line up", () => {
      const sets = parseQueryResultSets([[{ a: 1 }], { affectedRows: 1 }], ["only one"]);
      expect(sets.map((set) => set.sql)).toEqual([undefined, undefined]);
    });
  });
});
