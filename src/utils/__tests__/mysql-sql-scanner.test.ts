import { describe, expect, it } from "vitest";
import {
  MySQLStatementPlanError,
  planMySQLStatements,
  validateMySQLStatementPlans,
} from "../mysql-sql-scanner.js";

function mutablePlans(sql = "SELECT ?; SELECT ?", parameters: unknown[] = [1, 2]): any[] {
  return planMySQLStatements(sql, parameters).map((plan) => ({
    ...plan,
    sourceSpan: { ...plan.sourceSpan },
    executableTokens: plan.executableTokens.map((token) => ({
      ...token,
      sourceSpan: { ...token.sourceSpan },
    })),
    driverParameterOrdinals: [...plan.driverParameterOrdinals],
    executableParameterOrdinals: [...plan.executableParameterOrdinals],
  }));
}

describe("planMySQLStatements", () => {
  it.each(["", " ", ";", " ; "])("returns no plans for %j", (sql) => {
    expect(planMySQLStatements(sql, [])).toEqual([]);
  });

  it("preserves raw statement indexes and source spans", () => {
    const plans = planMySQLStatements(";;SELECT ?;", [1]);

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      statementIndex: 2,
      sourceSpan: { start: 2, end: 10 },
      executionKind: "executable",
      parameterStart: 0,
      parameterEnd: 1,
      driverParameterOrdinals: [0],
      executableParameterOrdinals: [0],
    });
    expect(Object.isFrozen(plans)).toBe(true);
    expect(Object.isFrozen(plans[0])).toBe(true);
    expect(Object.isFrozen(plans[0].sourceSpan)).toBe(true);
    expect(Object.isFrozen(plans[0].executableTokens)).toBe(true);
    expect(Object.isFrozen(plans[0].executableTokens[0])).toBe(true);
    expect(Object.isFrozen(plans[0].executableTokens[0].sourceSpan)).toBe(true);
    expect(Object.isFrozen(plans[0].driverParameterOrdinals)).toBe(true);
    expect(Object.isFrozen(plans[0].executableParameterOrdinals)).toBe(true);
  });

  it("keeps comment-only plans and their mysql2 driver parameters", () => {
    const plans = planMySQLStatements("/* ? */; SELECT ?", ["ignored", 7]);

    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({
      statementIndex: 0,
      sourceSpan: { start: 0, end: 7 },
      executionKind: "comment_only",
      executableTokens: [],
      parameterStart: 0,
      parameterEnd: 1,
      driverParameterOrdinals: [0],
      executableParameterOrdinals: [],
    });
    expect(plans[1]).toMatchObject({
      statementIndex: 1,
      sourceSpan: { start: 8, end: 17 },
      executionKind: "executable",
      parameterStart: 1,
      parameterEnd: 2,
      driverParameterOrdinals: [1],
      executableParameterOrdinals: [1],
    });
  });

  it("does not split semicolons in strings and counts comment parameters globally", () => {
    const plans = planMySQLStatements("SELECT ';' AS s; -- ?", ["comment"]);

    expect(plans.map((plan) => plan.statementIndex)).toEqual([0, 1]);
    expect(plans[0].sourceSpan).toEqual({ start: 0, end: 15 });
    expect(plans[0].driverParameterOrdinals).toEqual([]);
    expect(plans[1].executionKind).toBe("comment_only");
    expect(plans[1].driverParameterOrdinals).toEqual([0]);
    expect(plans[1].executableParameterOrdinals).toEqual([]);
  });

  it.each(["-- comment\r", "# comment\r"])(
    "ends a line comment at a carriage return for %s",
    (comment) => {
      const [plan] = planMySQLStatements(`SELECT 1 ${comment}, SLEEP(0)`);

      expect(
        plan.executableTokens
          .filter((token) => token.kind === "identifier")
          .map((token) => token.normalizedValue)
      ).toContain("SLEEP");
    }
  );

  it("scans executable MySQL comments but ignores MariaDB comments and optimizer hints", () => {
    const sql =
      "SELECT (/*!50000 SLEEP(?) */ 1), /*M! SELECT BENCHMARK(?, 1) */ ?, /*+ SET_VAR(x=?) */ ?";
    const plans = planMySQLStatements(sql, [1, 2, 3, 4, 5]);
    const [plan] = plans;

    expect(plan.driverParameterOrdinals).toEqual([0, 1, 2, 3, 4]);
    expect(plan.executableParameterOrdinals).toEqual([0, 2, 4]);
    expect(
      plan.executableTokens
        .filter((token) => token.kind === "identifier")
        .map((token) => [token.normalizedValue, token.source, token.depth])
    ).toContainEqual(["SLEEP", "executable_comment", 1]);
  });

  it("treats ?? as one driver and executable parameter", () => {
    const [plan] = planMySQLStatements("SELECT ?? FROM t WHERE id = ?", ["name", 1]);

    expect(plan.driverParameterOrdinals).toEqual([0, 1]);
    expect(plan.executableParameterOrdinals).toEqual([0, 1]);
    expect(
      plan.executableTokens.filter((token) => token.kind === "placeholder").map((token) => token.text)
    ).toEqual(["??", "?"]);
  });

  it("only doubles backticks to escape a quoted identifier", () => {
    const [plan] = planMySQLStatements("SELECT `x\\`, SLEEP(1)", []);

    expect(
      plan.executableTokens
        .filter((token) => token.kind === "identifier")
        .map((token) => token.normalizedValue)
    ).toContain("SLEEP");
  });

  it("records exact token spans, source, depth, and executable ordinals", () => {
    const sql = "SELECT (/*!50000 SLEEP(?) */ 1)";
    const [plan] = planMySQLStatements(sql, [1]);
    const sleep = plan.executableTokens.find(
      (token) => token.normalizedValue === "SLEEP"
    );
    const placeholder = plan.executableTokens.find(
      (token) => token.kind === "placeholder"
    );

    expect(sleep).toMatchObject({
      sourceSpan: {
        start: sql.indexOf("SLEEP"),
        end: sql.indexOf("SLEEP") + "SLEEP".length,
      },
      source: "executable_comment",
      depth: 1,
      quotedIdentifier: false,
    });
    expect(placeholder).toMatchObject({
      sourceSpan: {
        start: sql.indexOf("?"),
        end: sql.indexOf("?") + 1,
      },
      source: "executable_comment",
      depth: 2,
      parameterOrdinal: 0,
    });
    expect(plan.executableParameterOrdinals).toEqual([0]);
  });

  it.each([
    { name: "parameter count mismatch", sql: "SELECT ?", parameters: [] },
    { name: "long question-mark run", sql: "SELECT ???", parameters: [1, 2] },
    { name: "named placeholder", sql: "SELECT :value", parameters: [] },
    { name: "unterminated string", sql: "SELECT 'oops", parameters: [] },
    { name: "unterminated comment", sql: "SELECT /* oops", parameters: [] },
    { name: "unbalanced parentheses", sql: "SELECT (1", parameters: [] },
  ])("fails closed for $name", ({ sql, parameters }) => {
    expect(() => planMySQLStatements(sql, parameters)).toThrowError(
      expect.objectContaining({ category: "statement_plan_unsupported" })
    );
  });

  it("fails closed when mysql2 uses a custom queryFormat callback", () => {
    expect(() =>
      planMySQLStatements("SELECT ?", [1], { hasCustomQueryFormat: true })
    ).toThrowError(
      expect.objectContaining({ category: "statement_plan_unsupported" })
    );
  });

  const invariantCases: Array<{
    name: string;
    corrupt: (plans: any[]) => void;
    parameterCount: number;
  }> = [
    {
      name: "reversed source span",
      corrupt: (plans) => {
        plans[0].sourceSpan = { start: 8, end: 1 };
      },
      parameterCount: 2,
    },
    {
      name: "overlapping source spans",
      corrupt: (plans) => {
        plans[1].sourceSpan.start = plans[0].sourceSpan.end - 1;
      },
      parameterCount: 2,
    },
    {
      name: "reversed statement index",
      corrupt: (plans) => {
        plans[1].statementIndex = 0;
      },
      parameterCount: 2,
    },
    {
      name: "driver ordinal mismatch",
      corrupt: (plans) => {
        plans[1].driverParameterOrdinals = [0];
      },
      parameterCount: 2,
    },
    {
      name: "parameter slice overlap",
      corrupt: (plans) => {
        plans[1].parameterStart = 0;
        plans[1].parameterEnd = 1;
        plans[1].driverParameterOrdinals = [0];
        plans[1].executableParameterOrdinals = [0];
        plans[1].executableTokens.find(
          (token: any) => token.kind === "placeholder"
        ).parameterOrdinal = 0;
      },
      parameterCount: 1,
    },
    {
      name: "parameter slice gap",
      corrupt: (plans) => {
        plans[1].parameterStart = 2;
        plans[1].parameterEnd = 3;
        plans[1].driverParameterOrdinals = [2];
        plans[1].executableParameterOrdinals = [2];
        plans[1].executableTokens.find(
          (token: any) => token.kind === "placeholder"
        ).parameterOrdinal = 2;
      },
      parameterCount: 3,
    },
    { name: "parameter coverage gap", corrupt: () => {}, parameterCount: 3 },
    {
      name: "token span outside its statement",
      corrupt: (plans) => {
        plans[1].executableTokens[0].sourceSpan.start = 0;
      },
      parameterCount: 2,
    },
  ];

  it.each(invariantCases)(
    "classifies $name as an internal invariant failure",
    ({ corrupt, parameterCount }) => {
      const plans = mutablePlans();
      corrupt(plans);

      expect(() =>
        validateMySQLStatementPlans(plans, parameterCount, 18)
      ).toThrowError(
        expect.objectContaining({ category: "statement_plan_invariant_failed" })
      );
    }
  );

  it("rejects executable ordinals that do not match executable tokens", () => {
    const corrupted = mutablePlans("SELECT ?", [1]);
    corrupted[0].executableParameterOrdinals = [];

    expect(() => validateMySQLStatementPlans(corrupted, 1, 8)).toThrowError(
      expect.objectContaining({ category: "statement_plan_invariant_failed" })
    );
  });

  it("uses a typed planner error", () => {
    try {
      planMySQLStatements("SELECT ?", []);
      throw new Error("expected planner failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MySQLStatementPlanError);
    }
  });
});
