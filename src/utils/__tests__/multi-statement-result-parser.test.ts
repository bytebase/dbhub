import { vi, Mock, describe, expect, it, test } from "vitest";
import * as __testedFile from "../multi-statement-result-parser.js";

describe("src/utils/multi-statement-result-parser.ts", () => {
  describe("extractRowsFromMultiStatement", () => {
    const { extractRowsFromMultiStatement } = __testedFile;
    // multiStmntResults: any

    it("should test extractRowsFromMultiStatement( mock-parameters.multiStmntResults 1 )", () => {
      const multiStmntResults: Parameters<typeof extractRowsFromMultiStatement>[0] = "abc";
      const __expectedResult: ReturnType<typeof extractRowsFromMultiStatement> = [];
      expect(extractRowsFromMultiStatement(multiStmntResults)).toEqual(__expectedResult);
    });

    it("should test extractRowsFromMultiStatement( mock-parameters.multiStmntResults 2 )", () => {
      const multiStmntResults: Parameters<typeof extractRowsFromMultiStatement>[0] = 123;
      const __expectedResult: ReturnType<typeof extractRowsFromMultiStatement> = [];
      expect(extractRowsFromMultiStatement(multiStmntResults)).toEqual(__expectedResult);
    });

    it("should test extractRowsFromMultiStatement( mock-parameters.multiStmntResults 3 )", () => {
      const multiStmntResults: Parameters<typeof extractRowsFromMultiStatement>[0] = [
        [1, 2],
        { meta: true },
        [3],
      ];
      const __expectedResult: ReturnType<typeof extractRowsFromMultiStatement> = [1, 2, 3];
      expect(extractRowsFromMultiStatement(multiStmntResults)).toEqual(__expectedResult);
    });

    it("should test extractRowsFromMultiStatement( mock-parameters.multiStmntResults 4 )", () => {
      const multiStmntResults: Parameters<typeof extractRowsFromMultiStatement>[0] = [[], []];
      const __expectedResult: ReturnType<typeof extractRowsFromMultiStatement> = [];
      expect(extractRowsFromMultiStatement(multiStmntResults)).toEqual(__expectedResult);
    });

    it("should test extractRowsFromMultiStatement( mock-parameters.multiStmntResults 5 )", () => {
      const multiStmntResults: Parameters<typeof extractRowsFromMultiStatement>[0] = [
        [{ id: 1 }],
        [{ id: 2 }],
      ];
      const __expectedResult: ReturnType<typeof extractRowsFromMultiStatement> = [
        { id: 1 },
        { id: 2 },
      ];
      expect(extractRowsFromMultiStatement(multiStmntResults)).toEqual(__expectedResult);
    });

    it("should test extractRowsFromMultiStatement( mock-parameters.multiStmntResults 6 )", () => {
      const multiStmntResults: Parameters<typeof extractRowsFromMultiStatement>[0] = [
        [{ id: 1, name: "Alice" }],
      ];
      const __expectedResult: ReturnType<typeof extractRowsFromMultiStatement> = [
        { id: 1, name: "Alice" },
      ];
      expect(extractRowsFromMultiStatement(multiStmntResults)).toEqual(__expectedResult);
    });

    it("should test extractRowsFromMultiStatement( mock-parameters.multiStmntResults 7 )", () => {
      const multiStmntResults: Parameters<typeof extractRowsFromMultiStatement>[0] = [];
      const __expectedResult: ReturnType<typeof extractRowsFromMultiStatement> = [];
      expect(extractRowsFromMultiStatement(multiStmntResults)).toEqual(__expectedResult);
    });

    it("should test extractRowsFromMultiStatement( mock-parameters.multiStmntResults 8 )", () => {
      const multiStmntResults: Parameters<typeof extractRowsFromMultiStatement>[0] = [
        { affectedRows: 1 },
        [{ id: 99 }],
      ];
      const __expectedResult: ReturnType<typeof extractRowsFromMultiStatement> = [{ id: 99 }];
      expect(extractRowsFromMultiStatement(multiStmntResults)).toEqual(__expectedResult);
    });

    it("should test extractRowsFromMultiStatement( mock-parameters.multiStmntResults 9 )", () => {
      const multiStmntResults: Parameters<typeof extractRowsFromMultiStatement>[0] = [
        { affectedRows: 1, insertId: 0 },
      ];
      const __expectedResult: ReturnType<typeof extractRowsFromMultiStatement> = [];
      expect(extractRowsFromMultiStatement(multiStmntResults)).toEqual(__expectedResult);
    });

    it("should test extractRowsFromMultiStatement( mock-parameters.multiStmntResults 10 )", () => {
      const multiStmntResults: Parameters<typeof extractRowsFromMultiStatement>[0] = true;
      const __expectedResult: ReturnType<typeof extractRowsFromMultiStatement> = [];
      expect(extractRowsFromMultiStatement(multiStmntResults)).toEqual(__expectedResult);
    });

    it("should test extractRowsFromMultiStatement( mock-parameters.multiStmntResults 11 )", () => {
      const multiStmntResults: Parameters<typeof extractRowsFromMultiStatement>[0] = undefined;
      const __expectedResult: ReturnType<typeof extractRowsFromMultiStatement> = [];
      expect(extractRowsFromMultiStatement(multiStmntResults)).toEqual(__expectedResult);
    });

    it("should test extractRowsFromMultiStatement( mock-parameters.multiStmntResults 12 )", () => {
      const multiStmntResults: Parameters<typeof extractRowsFromMultiStatement>[0] = {
        data: [1, 2, 3],
      };
      const __expectedResult: ReturnType<typeof extractRowsFromMultiStatement> = [];
      expect(extractRowsFromMultiStatement(multiStmntResults)).toEqual(__expectedResult);
    });
  });

  describe("extractAffectedRows", () => {
    const { extractAffectedRows } = __testedFile;
    // affectedRows: any

    it("should test extractAffectedRows( mock-parameters.affectedRows 1 )", () => {
      const affectedRows: Parameters<typeof extractAffectedRows>[0] = "error";
      const __expectedResult: ReturnType<typeof extractAffectedRows> = 0;
      expect(extractAffectedRows(affectedRows)).toEqual(__expectedResult);
    });

    it("should test extractAffectedRows( mock-parameters.affectedRows 2 )", () => {
      const affectedRows: Parameters<typeof extractAffectedRows>[0] = [[]];
      const __expectedResult: ReturnType<typeof extractAffectedRows> = 0;
      expect(extractAffectedRows(affectedRows)).toEqual(__expectedResult);
    });

    it("should test extractAffectedRows( mock-parameters.affectedRows 3 )", () => {
      const affectedRows: Parameters<typeof extractAffectedRows>[0] = [[{ id: 1 }], []];
      const __expectedResult: ReturnType<typeof extractAffectedRows> = 1;
      expect(extractAffectedRows(affectedRows)).toEqual(__expectedResult);
    });

    it("should test extractAffectedRows( mock-parameters.affectedRows 4 )", () => {
      const affectedRows: Parameters<typeof extractAffectedRows>[0] = [
        [{ id: 1 }],
        [{ id: 2 }, { id: 3 }],
      ];
      const __expectedResult: ReturnType<typeof extractAffectedRows> = 3;
      expect(extractAffectedRows(affectedRows)).toEqual(__expectedResult);
    });

    it("should test extractAffectedRows( mock-parameters.affectedRows 5 )", () => {
      const affectedRows: Parameters<typeof extractAffectedRows>[0] = [];
      const __expectedResult: ReturnType<typeof extractAffectedRows> = 0;
      expect(extractAffectedRows(affectedRows)).toEqual(__expectedResult);
    });

    it("should test extractAffectedRows( mock-parameters.affectedRows 6 )", () => {
      const affectedRows: Parameters<typeof extractAffectedRows>[0] = [
        { affectedRows: 1 },
        [{ id: 1 }, { id: 2 }],
      ];
      const __expectedResult: ReturnType<typeof extractAffectedRows> = 3;
      expect(extractAffectedRows(affectedRows)).toEqual(__expectedResult);
    });

    it("should test extractAffectedRows( mock-parameters.affectedRows 7 )", () => {
      const affectedRows: Parameters<typeof extractAffectedRows>[0] = [
        { affectedRows: 10 },
        { affectedRows: 5 },
      ];
      const __expectedResult: ReturnType<typeof extractAffectedRows> = 15;
      expect(extractAffectedRows(affectedRows)).toEqual(__expectedResult);
    });

    it("should test extractAffectedRows( mock-parameters.affectedRows 8 )", () => {
      const affectedRows: Parameters<typeof extractAffectedRows>[0] = [{ id: 1 }, { id: 2 }];
      const __expectedResult: ReturnType<typeof extractAffectedRows> = 2;
      expect(extractAffectedRows(affectedRows)).toEqual(__expectedResult);
    });

    it("should test extractAffectedRows( mock-parameters.affectedRows 9 )", () => {
      const affectedRows: Parameters<typeof extractAffectedRows>[0] = [
        { warningStatus: 1, affectedRows: 2 },
      ];
      const __expectedResult: ReturnType<typeof extractAffectedRows> = 2;
      expect(extractAffectedRows(affectedRows)).toEqual(__expectedResult);
    });

    it("should test extractAffectedRows( mock-parameters.affectedRows 10 )", () => {
      const affectedRows: Parameters<typeof extractAffectedRows>[0] = undefined;
      const __expectedResult: ReturnType<typeof extractAffectedRows> = 0;
      expect(extractAffectedRows(affectedRows)).toEqual(__expectedResult);
    });

    it("should test extractAffectedRows( mock-parameters.affectedRows 11 )", () => {
      const affectedRows: Parameters<typeof extractAffectedRows>[0] = {
        affectedRows: 5,
        insertId: 1,
      };
      const __expectedResult: ReturnType<typeof extractAffectedRows> = 5;
      expect(extractAffectedRows(affectedRows)).toEqual(__expectedResult);
    });

    it("should test extractAffectedRows( mock-parameters.affectedRows 12 )", () => {
      const affectedRows: Parameters<typeof extractAffectedRows>[0] = { insertId: 1 };
      const __expectedResult: ReturnType<typeof extractAffectedRows> = 0;
      expect(extractAffectedRows(affectedRows)).toEqual(__expectedResult);
    });
  });

  describe("parseQueryResults", () => {
    const { parseQueryResults } = __testedFile;
    // queryResults: any

    it("should test parseQueryResults( mock-parameters.queryResults 1 )", () => {
      const queryResults: Parameters<typeof parseQueryResults>[0] = 123;
      const __expectedResult: ReturnType<typeof parseQueryResults> = [];
      expect(parseQueryResults(queryResults)).toEqual(__expectedResult);
    });

    it("should test parseQueryResults( mock-parameters.queryResults 2 )", () => {
      const queryResults: Parameters<typeof parseQueryResults>[0] = [[{ id: 1 }], [{ id: 2 }]];
      const __expectedResult: ReturnType<typeof parseQueryResults> = [{ id: 1 }, { id: 2 }];
      expect(parseQueryResults(queryResults)).toEqual(__expectedResult);
    });

    it("should test parseQueryResults( mock-parameters.queryResults 3 )", () => {
      const queryResults: Parameters<typeof parseQueryResults>[0] = [];
      const __expectedResult: ReturnType<typeof parseQueryResults> = [];
      expect(parseQueryResults(queryResults)).toEqual(__expectedResult);
    });

    it("should test parseQueryResults( mock-parameters.queryResults 4 )", () => {
      const queryResults: Parameters<typeof parseQueryResults>[0] = [
        { affectedRows: 1 },
        [{ id: 5 }],
      ];
      const __expectedResult: ReturnType<typeof parseQueryResults> = [{ id: 5 }];
      expect(parseQueryResults(queryResults)).toEqual(__expectedResult);
    });

    it("should test parseQueryResults( mock-parameters.queryResults 5 )", () => {
      const queryResults: Parameters<typeof parseQueryResults>[0] = [
        { affectedRows: 1 },
        { insertId: 2 },
      ];
      const __expectedResult: ReturnType<typeof parseQueryResults> = [];
      expect(parseQueryResults(queryResults)).toEqual(__expectedResult);
    });

    it("should test parseQueryResults( mock-parameters.queryResults 6 )", () => {
      const queryResults: Parameters<typeof parseQueryResults>[0] = [{ id: 1 }, { id: 2 }];
      const __expectedResult: ReturnType<typeof parseQueryResults> = [{ id: 1 }, { id: 2 }];
      expect(parseQueryResults(queryResults)).toEqual(__expectedResult);
    });

    it("should test parseQueryResults( mock-parameters.queryResults 7 )", () => {
      const queryResults: Parameters<typeof parseQueryResults>[0] = [
        { warningStatus: 0 },
        [{ id: 1 }],
      ];
      const __expectedResult: ReturnType<typeof parseQueryResults> = [{ id: 1 }];
      expect(parseQueryResults(queryResults)).toEqual(__expectedResult);
    });

    it("should test parseQueryResults( mock-parameters.queryResults 8 )", () => {
      const queryResults: Parameters<typeof parseQueryResults>[0] = undefined;
      const __expectedResult: ReturnType<typeof parseQueryResults> = [];
      expect(parseQueryResults(queryResults)).toEqual(__expectedResult);
    });

    it("should test parseQueryResults( mock-parameters.queryResults 9 )", () => {
      const queryResults: Parameters<typeof parseQueryResults>[0] = { affectedRows: 1 };
      const __expectedResult: ReturnType<typeof parseQueryResults> = [];
      expect(parseQueryResults(queryResults)).toEqual(__expectedResult);
    });
  });
});

// 3TG (https://3tg.dev) created 33 tests in 3230 ms (97.879 ms per generated test) @ 2026-03-26T18:04:19.473Z
