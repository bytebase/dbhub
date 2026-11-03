import { describe, it, expect } from "vitest";
import { uniqueColumnNames, rowsFromArrays, objectRows } from "../result-columns.js";

describe("uniqueColumnNames", () => {
  it("leaves unique names untouched", () => {
    expect(uniqueColumnNames(["id", "name", "email"])).toEqual(["id", "name", "email"]);
  });

  it("suffixes later occurrences of a repeated name", () => {
    expect(uniqueColumnNames(["a", "a"])).toEqual(["a", "a_1"]);
    expect(uniqueColumnNames(["count", "count", "count"])).toEqual(["count", "count_1", "count_2"]);
  });

  it("never reuses a name the result already has", () => {
    // The caller aliased a column `a_1` themselves: it keeps that name, and
    // the duplicate `a` skips past it.
    expect(uniqueColumnNames(["a", "a", "a_1"])).toEqual(["a", "a_2", "a_1"]);
    expect(uniqueColumnNames(["a", "a_1", "a"])).toEqual(["a", "a_1", "a_2"]);
  });

  it("keeps renamed columns distinct from each other", () => {
    expect(uniqueColumnNames(["a", "a", "b", "b"])).toEqual(["a", "a_1", "b", "b_1"]);
  });

  it("handles the empty column name and an empty list", () => {
    expect(uniqueColumnNames(["", ""])).toEqual(["", "_1"]);
    expect(uniqueColumnNames([])).toEqual([]);
  });
});

describe("rowsFromArrays", () => {
  it("zips each positional row with the column names", () => {
    expect(rowsFromArrays(["a", "a_1"], [[1, 2], [3, 4]])).toEqual([
      { a: 1, a_1: 2 },
      { a: 3, a_1: 4 },
    ]);
  });

  it("passes rows that are already objects through unchanged", () => {
    const row = { a: 1 };
    expect(rowsFromArrays(["a"], [row])[0]).toBe(row);
  });

  it("returns an empty list for no rows", () => {
    expect(rowsFromArrays(["a"], [])).toEqual([]);
  });

  it("keeps a column named __proto__ as an own, serialisable property", () => {
    const [row] = rowsFromArrays(uniqueColumnNames(["__proto__", "__proto__"]), [[1, 2]]);
    expect(Object.keys(row)).toEqual(["__proto__", "__proto___1"]);
    // Compared as text: a `{ __proto__: 1 }` literal in source would set the
    // prototype instead of a key, so it cannot express the expected value.
    expect(JSON.stringify(row)).toBe('{"__proto__":1,"__proto___1":2}');
    expect(Object.getPrototypeOf(row)).toBeNull();
  });
});

describe("objectRows", () => {
  it("keeps every value of a result with repeated column names", () => {
    expect(objectRows(["count", "count"], [[10, 3]])).toEqual([{ count: 10, count_1: 3 }]);
  });
});
