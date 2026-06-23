import { describe, it, expect } from "vitest";
import { classifyConnectionError, TUNNEL_ERROR_MARKER } from "../error-classifier.js";

describe("classifyConnectionError", () => {
  it("classifies network socket errors as SOURCE_UNREACHABLE", () => {
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"]) {
      const result = classifyConnectionError({ code }, "postgres", "staging");
      expect(result?.code).toBe("SOURCE_UNREACHABLE");
      expect(result?.message).toContain("staging");
    }
  });

  it("classifies postgres auth errors as AUTH_FAILED", () => {
    expect(classifyConnectionError({ code: "28P01" }, "postgres", "prod")?.code).toBe("AUTH_FAILED");
    expect(classifyConnectionError({ code: "28000" }, "postgres", "prod")?.code).toBe("AUTH_FAILED");
  });

  it("classifies mysql/mariadb auth errors via code or errno", () => {
    expect(classifyConnectionError({ code: "ER_ACCESS_DENIED_ERROR" }, "mysql", "m")?.code).toBe("AUTH_FAILED");
    expect(classifyConnectionError({ errno: 1045 }, "mariadb", "m")?.code).toBe("AUTH_FAILED");
    // 1698 = ER_ACCESS_DENIED_NO_PASSWORD_ERROR
    expect(classifyConnectionError({ errno: 1698 }, "mysql", "m")?.code).toBe("AUTH_FAILED");
    expect(classifyConnectionError({ errno: 1698 }, "mariadb", "m")?.code).toBe("AUTH_FAILED");
  });

  it("classifies sqlserver login errors as AUTH_FAILED", () => {
    expect(classifyConnectionError({ code: "ELOGIN" }, "sqlserver", "s")?.code).toBe("AUTH_FAILED");
  });

  it("classifies marked SSH tunnel errors as TUNNEL_FAILED, ahead of network code", () => {
    const err: any = { code: "ECONNREFUSED" };
    err[TUNNEL_ERROR_MARKER] = true;
    expect(classifyConnectionError(err, "postgres", "viaBastion")?.code).toBe("TUNNEL_FAILED");
  });

  it("returns null for unrecognized errors and non-objects", () => {
    expect(classifyConnectionError({ code: "42601" }, "postgres", "x")).toBeNull(); // syntax error
    expect(classifyConnectionError(new Error("boom"), "postgres", "x")).toBeNull();
    expect(classifyConnectionError("nope", "postgres", "x")).toBeNull();
    expect(classifyConnectionError(null, "postgres", "x")).toBeNull();
  });

  it("does not treat a mysql auth code as auth for a postgres source", () => {
    expect(classifyConnectionError({ errno: 1045 }, "postgres", "x")).toBeNull();
  });
});
