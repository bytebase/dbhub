import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteConnector } from "../sqlite/index.js";

describe("SQLite custom-tool parameter types", () => {
  let connector: SQLiteConnector;
  beforeEach(async () => {
    connector = new SQLiteConnector();
    await connector.connect("sqlite:///:memory:");
    await connector.executeSQL("CREATE TABLE tasks (id INTEGER, done INTEGER, tags TEXT, payload BLOB)", {});
  });
  afterEach(async () => { await connector.disconnect(); });

  it("binds boolean and array parameters for writes and filtered reads", async () => {
    const tags = ["agent", "reader's notes", true, null, { priority: 1 }];
    await connector.executeSQL(
      "INSERT INTO tasks VALUES (?, ?, ?, ?)", {},
      [1, false, tags, new Uint8Array([0, 255])]
    );
    await connector.executeSQL("UPDATE tasks SET done = ? WHERE id = ?", {}, [true, 1]);
    const result = await connector.executeSQL(
      "SELECT done, tags, hex(payload) AS payload FROM tasks WHERE done = ? AND id IN (SELECT value FROM json_each(?))",
      { readonly: true }, [true, [1, 2]]
    );
    expect(result.resultSets[0].rows).toEqual([{ done: 1n, tags: JSON.stringify(tags), payload: "00FF" }]);
    const empty = await connector.executeSQL(
      "SELECT * FROM tasks WHERE id IN (SELECT value FROM json_each(?))", {}, [[]]
    );
    expect(empty.resultSets[0].rows).toEqual([]);
  });

  it("keeps scalar and null bindings and restores writability after a rejected write", async () => {
    await expect(connector.executeSQL(
      "INSERT INTO tasks VALUES (?, ?, ?, ?)", { readonly: true }, [2, true, [], null]
    )).rejects.toThrow(/readonly/i);
    await connector.executeSQL("INSERT INTO tasks VALUES (?, ?, ?, ?)", {}, [2, false, [], null]);
    const result = await connector.executeSQL("SELECT ? AS text, ? AS number, ? AS absent", {}, ["hello", 1.5, null]);
    expect(result.resultSets[0].rows).toEqual([{ text: "hello", number: 1.5, absent: null }]);
  });
});
