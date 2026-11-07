import { describe, it, expect } from "vitest";
import {
  detectReadOnlyBackstop,
  readOnlyFlagQuery,
  readOnlyClose,
  READ_ONLY_OPEN,
} from "../readonly-transaction.js";

describe("detectReadOnlyBackstop", () => {
  it.each([
    ["8.0.36", "transaction_read_only"],
    ["8.4.0", "transaction_read_only"],
    ["5.7.44-log", "transaction_read_only"],
    ["5.7.20", "transaction_read_only"],
    // transaction_read_only arrived in 5.7.20; older servers only have tx_read_only.
    ["5.7.19-log", "tx_read_only"],
    ["5.6.51", "tx_read_only"],
    // MariaDB kept tx_read_only (11.1 only added the new name as an alias).
    ["10.11.8-MariaDB-ubu2204", "tx_read_only"],
    ["11.4.2-MariaDB-ubu2404", "tx_read_only"],
  ])("picks the session variable for %s", (version, variable) => {
    expect(detectReadOnlyBackstop(version)).toEqual({ kind: "session", variable });
  });

  it("falls back to a rolled-back plain transaction on TiDB", () => {
    expect(detectReadOnlyBackstop("8.0.11-TiDB-v7.5.0")).toEqual({ kind: "rollback" });
  });

  it("assumes a current MySQL when the version is unreadable", () => {
    expect(detectReadOnlyBackstop(undefined)).toEqual({
      kind: "session",
      variable: "transaction_read_only",
    });
  });
});

describe("read-only guard statements", () => {
  it("reads the flag, raises it with the transaction, and restores it as a literal", () => {
    expect(readOnlyFlagQuery("tx_read_only")).toBe("SELECT @@session.tx_read_only AS ro");
    expect(READ_ONLY_OPEN).toBe("SET SESSION TRANSACTION READ ONLY; START TRANSACTION READ ONLY");
    // The restore carries the value DBHub read, not a server-side variable the
    // executed SQL could have overwritten.
    expect(readOnlyClose("tx_read_only", "ROLLBACK", 1)).toBe("ROLLBACK; SET SESSION tx_read_only = 1");
    expect(readOnlyClose("transaction_read_only", "COMMIT", 0)).toBe(
      "COMMIT; SET SESSION transaction_read_only = 0"
    );
  });
});
