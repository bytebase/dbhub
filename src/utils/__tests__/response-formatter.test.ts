import { describe, expect, it } from "vitest";
import * as __testedFile from "../response-formatter.js";

const testData = {
  id: 1,
};
const testMeta = {
  affectedRows: 1,
};
const testDetails = {
  reason: 1,
};
const testReferences = ["ref"];

const cteContent = {
  type: "text" as const,
  text: '{\n  "success": false,\n  "error": "err",\n  "code": "ERROR"\n}',
  mimeType: "application/json",
};

// These are also used by tests for createResourceErrorResponse
const ctTextFatal = '{\n  "success": false,\n  "error": "err",\n  "code": "FATAL"\n}';
const ctTextErrorDetails =
  '{\n  "success": false,\n  "error": "err",\n  "code": "ERROR",\n  "details": {\n    "reason": 1\n  }\n}';
const ctTextFatalDetails =
  '{\n  "success": false,\n  "error": "err",\n  "code": "FATAL",\n  "details": {\n    "reason": 1\n  }\n}';

const ctsContent = {
  type: "text" as const,
  text: '{\n  "success": true,\n  "data": {\n    "id": 1\n  }\n}',
  mimeType: "application/json",
};

const ctsTextMeta =
  '{\n  "success": true,\n  "data": {\n    "id": 1\n  },\n  "meta": {\n    "affectedRows\": 1\n  }\n}';
const ctrContent = {
  uri: "uri",
  text: '{\n  "success": false,\n  "error": "err",\n  "code": "ERROR"\n}',
  mimeType: "application/json",
};

const crsContent = {
  uri: "uri",
  text: '{\n  "success": true,\n  "data": {\n    "id": 1\n  }\n}',
  mimeType: "application/json",
};

const fpsMessage = {
  role: "assistant" as const,
  content: {
    type: "text" as const,
    text: "txt",
  },
};

const fpeMessage = {
  role: "assistant" as const,
  content: {
    type: "text" as const,
    text: `Error: err`,
  },
};

describe("src/utils/response-formatter.ts", () => {
  describe("formatSuccessResponse", () => {
    const { formatSuccessResponse } = __testedFile;
    // data: T
    // meta: Record<string, any>

    it("should test formatSuccessResponse( mock-parameters.data 1, mock-parameters.meta 1 )", () => {
      const data: Parameters<typeof formatSuccessResponse>[0] = testData;
      const meta: Parameters<typeof formatSuccessResponse>[1] = testMeta;
      const __expectedResult: ReturnType<typeof formatSuccessResponse> = {
        success: true,
        data: testData,
        meta: testMeta,
      };
      expect(formatSuccessResponse(data, meta)).toEqual(__expectedResult);
    });

    it("should test formatSuccessResponse( mock-parameters.data 1, mock-parameters.meta 2 )", () => {
      const data: Parameters<typeof formatSuccessResponse>[0] = testData;
      const meta: Parameters<typeof formatSuccessResponse>[1] = undefined;
      const __expectedResult: ReturnType<typeof formatSuccessResponse> = {
        success: true,
        data: testData,
      };
      expect(formatSuccessResponse(data, meta)).toEqual(__expectedResult);
    });

    it("should test formatSuccessResponse( mock-parameters.data 1, mock-parameters.meta 3 )", () => {
      const data: Parameters<typeof formatSuccessResponse>[0] = testData;
      const meta: Parameters<typeof formatSuccessResponse>[1] = {};
      const __expectedResult: ReturnType<typeof formatSuccessResponse> = {
        success: true,
        data: testData,
      };
      expect(formatSuccessResponse(data, meta)).toEqual(__expectedResult);
    });
  });

  describe("formatErrorResponse", () => {
    const { formatErrorResponse } = __testedFile;
    // error: string
    // code: string
    // details: undefined | any

    it("should test formatErrorResponse( mock-parameters.error 1, mock-parameters.code 1, mock-parameters.details 1 )", () => {
      const error: Parameters<typeof formatErrorResponse>[0] = "err";
      const code: Parameters<typeof formatErrorResponse>[1] = "ERROR";
      const details: Parameters<typeof formatErrorResponse>[2] = testDetails;
      const __expectedResult: ReturnType<typeof formatErrorResponse> = {
        success: false,
        error: "err",
        code: "ERROR",
        details: testDetails,
      };
      expect(formatErrorResponse(error, code, details)).toEqual(__expectedResult);
    });

    it("should test formatErrorResponse( mock-parameters.error 1, mock-parameters.code 2, mock-parameters.details 1 )", () => {
      const error: Parameters<typeof formatErrorResponse>[0] = "err";
      const code: Parameters<typeof formatErrorResponse>[1] = "FATAL";
      const details: Parameters<typeof formatErrorResponse>[2] = testDetails;
      const __expectedResult: ReturnType<typeof formatErrorResponse> = {
        success: false,
        error: "err",
        code: "FATAL",
        details: testDetails,
      };
      expect(formatErrorResponse(error, code, details)).toEqual(__expectedResult);
    });

    it("should test formatErrorResponse( mock-parameters.error 1, mock-parameters.code 3, mock-parameters.details 1 )", () => {
      const error: Parameters<typeof formatErrorResponse>[0] = "err";
      const code: Parameters<typeof formatErrorResponse>[1] = undefined;
      const details: Parameters<typeof formatErrorResponse>[2] = testDetails;
      const __expectedResult: ReturnType<typeof formatErrorResponse> = {
        success: false,
        error: "err",
        code: "ERROR",
        details: testDetails,
      };
      expect(formatErrorResponse(error, code, details)).toEqual(__expectedResult);
    });

    it("should test formatErrorResponse( mock-parameters.error 1, mock-parameters.code 1, mock-parameters.details 2 )", () => {
      const error: Parameters<typeof formatErrorResponse>[0] = "err";
      const code: Parameters<typeof formatErrorResponse>[1] = "ERROR";
      const details: Parameters<typeof formatErrorResponse>[2] = undefined;
      const __expectedResult: ReturnType<typeof formatErrorResponse> = {
        success: false,
        error: "err",
        code: "ERROR",
      };
      expect(formatErrorResponse(error, code, details)).toEqual(__expectedResult);
    });

    it("should test formatErrorResponse( mock-parameters.error 1, mock-parameters.code 2, mock-parameters.details 2 )", () => {
      const error: Parameters<typeof formatErrorResponse>[0] = "err";
      const code: Parameters<typeof formatErrorResponse>[1] = "FATAL";
      const details: Parameters<typeof formatErrorResponse>[2] = undefined;
      const __expectedResult: ReturnType<typeof formatErrorResponse> = {
        success: false,
        error: "err",
        code: "FATAL",
      };
      expect(formatErrorResponse(error, code, details)).toEqual(__expectedResult);
    });

    it("should test formatErrorResponse( mock-parameters.error 1, mock-parameters.code 3, mock-parameters.details 2 )", () => {
      const error: Parameters<typeof formatErrorResponse>[0] = "err";
      const code: Parameters<typeof formatErrorResponse>[1] = undefined;
      const details: Parameters<typeof formatErrorResponse>[2] = undefined;
      const __expectedResult: ReturnType<typeof formatErrorResponse> = {
        success: false,
        error: "err",
        code: "ERROR",
      };
      expect(formatErrorResponse(error, code, details)).toEqual(__expectedResult);
    });
  });

  describe("createToolErrorResponse", () => {
    const { createToolErrorResponse } = __testedFile;
    // error: string
    // code: string
    // details: undefined | any

    it("should test createToolErrorResponse( mock-parameters.error 1, mock-parameters.code 1, mock-parameters.details 1 )", () => {
      const error: Parameters<typeof createToolErrorResponse>[0] = "err";
      const code: Parameters<typeof createToolErrorResponse>[1] = "ERROR";
      const details: Parameters<typeof createToolErrorResponse>[2] = testDetails;
      const __expectedResult: ReturnType<typeof createToolErrorResponse> = {
        isError: true,
        content: [{ ...cteContent, text: ctTextErrorDetails }],
      };
      expect(createToolErrorResponse(error, code, details)).toEqual(__expectedResult);
    });

    it("should test createToolErrorResponse( mock-parameters.error 1, mock-parameters.code 2, mock-parameters.details 1 )", () => {
      const error: Parameters<typeof createToolErrorResponse>[0] = "err";
      const code: Parameters<typeof createToolErrorResponse>[1] = "FATAL";
      const details: Parameters<typeof createToolErrorResponse>[2] = testDetails;
      const __expectedResult: ReturnType<typeof createToolErrorResponse> = {
        isError: true,
        content: [{ ...cteContent, text: ctTextFatalDetails }],
      };
      expect(createToolErrorResponse(error, code, details)).toEqual(__expectedResult);
    });

    it("should test createToolErrorResponse( mock-parameters.error 1, mock-parameters.code 3, mock-parameters.details 1 )", () => {
      const error: Parameters<typeof createToolErrorResponse>[0] = "err";
      const code: Parameters<typeof createToolErrorResponse>[1] = undefined;
      const details: Parameters<typeof createToolErrorResponse>[2] = testDetails;
      const __expectedResult: ReturnType<typeof createToolErrorResponse> = {
        isError: true,
        content: [{ ...cteContent, text: ctTextErrorDetails }],
      };
      expect(createToolErrorResponse(error, code, details)).toEqual(__expectedResult);
    });

    it("should test createToolErrorResponse( mock-parameters.error 1, mock-parameters.code 1, mock-parameters.details 2 )", () => {
      const error: Parameters<typeof createToolErrorResponse>[0] = "err";
      const code: Parameters<typeof createToolErrorResponse>[1] = "ERROR";
      const details: Parameters<typeof createToolErrorResponse>[2] = undefined;
      const __expectedResult: ReturnType<typeof createToolErrorResponse> = {
        isError: true,
        content: [cteContent],
      };
      expect(createToolErrorResponse(error, code, details)).toEqual(__expectedResult);
    });

    it("should test createToolErrorResponse( mock-parameters.error 1, mock-parameters.code 2, mock-parameters.details 2 )", () => {
      const error: Parameters<typeof createToolErrorResponse>[0] = "err";
      const code: Parameters<typeof createToolErrorResponse>[1] = "FATAL";
      const details: Parameters<typeof createToolErrorResponse>[2] = undefined;
      const __expectedResult: ReturnType<typeof createToolErrorResponse> = {
        isError: true,
        content: [{ ...cteContent, text: ctTextFatal }],
      };
      expect(createToolErrorResponse(error, code, details)).toEqual(__expectedResult);
    });

    it("should test createToolErrorResponse( mock-parameters.error 1, mock-parameters.code 3, mock-parameters.details 2 )", () => {
      const error: Parameters<typeof createToolErrorResponse>[0] = "err";
      const code: Parameters<typeof createToolErrorResponse>[1] = undefined;
      const details: Parameters<typeof createToolErrorResponse>[2] = undefined;
      const __expectedResult: ReturnType<typeof createToolErrorResponse> = {
        isError: true,
        content: [cteContent],
      };
      expect(createToolErrorResponse(error, code, details)).toEqual(__expectedResult);
    });
  });

  describe("createToolSuccessResponse", () => {
    const { createToolSuccessResponse } = __testedFile;
    // data: T
    // meta: Record<string, any>

    it("should test createToolSuccessResponse( mock-parameters.data 1, mock-parameters.meta 1 )", () => {
      const data: Parameters<typeof createToolSuccessResponse>[0] = testData;
      const meta: Parameters<typeof createToolSuccessResponse>[1] = testMeta;
      const __expectedResult: ReturnType<typeof createToolSuccessResponse> = {
        content: [{ ...ctsContent, text: ctsTextMeta }],
      };
      expect(createToolSuccessResponse(data, meta)).toEqual(__expectedResult);
    });

    it("should test createToolSuccessResponse( mock-parameters.data 1, mock-parameters.meta 2 )", () => {
      const data: Parameters<typeof createToolSuccessResponse>[0] = testData;
      const meta: Parameters<typeof createToolSuccessResponse>[1] = undefined;
      const __expectedResult: ReturnType<typeof createToolSuccessResponse> = {
        content: [ctsContent],
      };
      expect(createToolSuccessResponse(data, meta)).toEqual(__expectedResult);
    });

    it("should test createToolSuccessResponse( mock-parameters.data 1, mock-parameters.meta 3 )", () => {
      const data: Parameters<typeof createToolSuccessResponse>[0] = testData;
      const meta: Parameters<typeof createToolSuccessResponse>[1] = {};
      const __expectedResult: ReturnType<typeof createToolSuccessResponse> = {
        content: [ctsContent],
      };
      expect(createToolSuccessResponse(data, meta)).toEqual(__expectedResult);
    });
  });

  describe("createResourceErrorResponse", () => {
    const { createResourceErrorResponse } = __testedFile;
    // uri: string
    // error: string
    // code: string
    // details: undefined | any

    it("should test createResourceErrorResponse( mock-parameters.uri 1, mock-parameters.error 1, mock-parameters.code 1, mock-parameters.details 1 )", () => {
      const uri: Parameters<typeof createResourceErrorResponse>[0] = "uri";
      const error: Parameters<typeof createResourceErrorResponse>[1] = "err";
      const code: Parameters<typeof createResourceErrorResponse>[2] = "ERROR";
      const details: Parameters<typeof createResourceErrorResponse>[3] = testDetails;
      const __expectedResult: ReturnType<typeof createResourceErrorResponse> = {
        contents: [{ ...ctrContent, text: ctTextErrorDetails }],
      };
      expect(createResourceErrorResponse(uri, error, code, details)).toEqual(__expectedResult);
    });

    it("should test createResourceErrorResponse( mock-parameters.uri 1, mock-parameters.error 1, mock-parameters.code 2, mock-parameters.details 1 )", () => {
      const uri: Parameters<typeof createResourceErrorResponse>[0] = "uri";
      const error: Parameters<typeof createResourceErrorResponse>[1] = "err";
      const code: Parameters<typeof createResourceErrorResponse>[2] = "FATAL";
      const details: Parameters<typeof createResourceErrorResponse>[3] = testDetails;
      const __expectedResult: ReturnType<typeof createResourceErrorResponse> = {
        contents: [{ ...ctrContent, text: ctTextFatalDetails }],
      };
      expect(createResourceErrorResponse(uri, error, code, details)).toEqual(__expectedResult);
    });

    it("should test createResourceErrorResponse( mock-parameters.uri 1, mock-parameters.error 1, mock-parameters.code 3, mock-parameters.details 1 )", () => {
      const uri: Parameters<typeof createResourceErrorResponse>[0] = "uri";
      const error: Parameters<typeof createResourceErrorResponse>[1] = "err";
      const code: Parameters<typeof createResourceErrorResponse>[2] = undefined;
      const details: Parameters<typeof createResourceErrorResponse>[3] = testDetails;
      const __expectedResult: ReturnType<typeof createResourceErrorResponse> = {
        contents: [{ ...ctrContent, text: ctTextErrorDetails }],
      };
      expect(createResourceErrorResponse(uri, error, code, details)).toEqual(__expectedResult);
    });

    it("should test createResourceErrorResponse( mock-parameters.uri 1, mock-parameters.error 1, mock-parameters.code 1, mock-parameters.details 2 )", () => {
      const uri: Parameters<typeof createResourceErrorResponse>[0] = "uri";
      const error: Parameters<typeof createResourceErrorResponse>[1] = "err";
      const code: Parameters<typeof createResourceErrorResponse>[2] = "ERROR";
      const details: Parameters<typeof createResourceErrorResponse>[3] = undefined;
      const __expectedResult: ReturnType<typeof createResourceErrorResponse> = {
        contents: [ctrContent],
      };
      expect(createResourceErrorResponse(uri, error, code, details)).toEqual(__expectedResult);
    });

    it("should test createResourceErrorResponse( mock-parameters.uri 1, mock-parameters.error 1, mock-parameters.code 2, mock-parameters.details 2 )", () => {
      const uri: Parameters<typeof createResourceErrorResponse>[0] = "uri";
      const error: Parameters<typeof createResourceErrorResponse>[1] = "err";
      const code: Parameters<typeof createResourceErrorResponse>[2] = "FATAL";
      const details: Parameters<typeof createResourceErrorResponse>[3] = undefined;
      const __expectedResult: ReturnType<typeof createResourceErrorResponse> = {
        contents: [{ ...ctrContent, text: ctTextFatal }],
      };
      expect(createResourceErrorResponse(uri, error, code, details)).toEqual(__expectedResult);
    });

    it("should test createResourceErrorResponse( mock-parameters.uri 1, mock-parameters.error 1, mock-parameters.code 3, mock-parameters.details 2 )", () => {
      const uri: Parameters<typeof createResourceErrorResponse>[0] = "uri";
      const error: Parameters<typeof createResourceErrorResponse>[1] = "err";
      const code: Parameters<typeof createResourceErrorResponse>[2] = undefined;
      const details: Parameters<typeof createResourceErrorResponse>[3] = undefined;
      const __expectedResult: ReturnType<typeof createResourceErrorResponse> = {
        contents: [ctrContent],
      };
      expect(createResourceErrorResponse(uri, error, code, details)).toEqual(__expectedResult);
    });
  });

  describe("createResourceSuccessResponse", () => {
    const { createResourceSuccessResponse } = __testedFile;
    // uri: string
    // data: T
    // meta: Record<string, any>

    it("should test createResourceSuccessResponse( mock-parameters.uri 1, mock-parameters.data 1, mock-parameters.meta 1 )", () => {
      const uri: Parameters<typeof createResourceSuccessResponse>[0] = "uri";
      const data: Parameters<typeof createResourceSuccessResponse>[1] = testData;
      const meta: Parameters<typeof createResourceSuccessResponse>[2] = testMeta;
      const __expectedResult: ReturnType<typeof createResourceSuccessResponse> = {
        contents: [{ ...crsContent, text: ctsTextMeta }],
      };
      expect(createResourceSuccessResponse(uri, data, meta)).toEqual(__expectedResult);
    });

    it("should test createResourceSuccessResponse( mock-parameters.uri 1, mock-parameters.data 1, mock-parameters.meta 2 )", () => {
      const uri: Parameters<typeof createResourceSuccessResponse>[0] = "uri";
      const data: Parameters<typeof createResourceSuccessResponse>[1] = testData;
      const meta: Parameters<typeof createResourceSuccessResponse>[2] = undefined;
      const __expectedResult: ReturnType<typeof createResourceSuccessResponse> = {
        contents: [crsContent],
      };
      expect(createResourceSuccessResponse(uri, data, meta)).toEqual(__expectedResult);
    });

    it("should test createResourceSuccessResponse( mock-parameters.uri 1, mock-parameters.data 1, mock-parameters.meta 3 )", () => {
      const uri: Parameters<typeof createResourceSuccessResponse>[0] = "uri";
      const data: Parameters<typeof createResourceSuccessResponse>[1] = testData;
      const meta: Parameters<typeof createResourceSuccessResponse>[2] = {};
      const __expectedResult: ReturnType<typeof createResourceSuccessResponse> = {
        contents: [crsContent],
      };
      expect(createResourceSuccessResponse(uri, data, meta)).toEqual(__expectedResult);
    });
  });

  describe("formatPromptSuccessResponse", () => {
    const { formatPromptSuccessResponse } = __testedFile;
    // text: string
    // references: string[]

    it("should test formatPromptSuccessResponse( mock-parameters.text 1, mock-parameters.references 1 )", () => {
      const text: Parameters<typeof formatPromptSuccessResponse>[0] = "txt";
      const references: Parameters<typeof formatPromptSuccessResponse>[1] = [];
      const __expectedResult: ReturnType<typeof formatPromptSuccessResponse> = {
        messages: [fpsMessage],
      };
      expect(formatPromptSuccessResponse(text, references)).toEqual(__expectedResult);
    });

    it("should test formatPromptSuccessResponse( mock-parameters.text 1, mock-parameters.references 2 )", () => {
      const text: Parameters<typeof formatPromptSuccessResponse>[0] = "txt";
      const references: Parameters<typeof formatPromptSuccessResponse>[1] = testReferences;
      const __expectedResult: ReturnType<typeof formatPromptSuccessResponse> = {
        messages: [fpsMessage],
        references: testReferences,
      };
      expect(formatPromptSuccessResponse(text, references)).toEqual(__expectedResult);
    });

    it("should test formatPromptSuccessResponse( mock-parameters.text 1, mock-parameters.references 3 )", () => {
      const text: Parameters<typeof formatPromptSuccessResponse>[0] = "txt";
      const references: Parameters<typeof formatPromptSuccessResponse>[1] = undefined;
      const __expectedResult: ReturnType<typeof formatPromptSuccessResponse> = {
        messages: [fpsMessage],
      };
      expect(formatPromptSuccessResponse(text, references)).toEqual(__expectedResult);
    });
  });

  describe("formatPromptErrorResponse", () => {
    const { formatPromptErrorResponse } = __testedFile;
    // error: string
    // code: string

    it("should test formatPromptErrorResponse( mock-parameters.error 1, mock-parameters.code 1 )", () => {
      const error: Parameters<typeof formatPromptErrorResponse>[0] = "err";
      const code: Parameters<typeof formatPromptErrorResponse>[1] = "ERROR";
      const __expectedResult: ReturnType<typeof formatPromptErrorResponse> = {
        messages: [fpeMessage],
        error: "err",
        code: "ERROR",
      };
      expect(formatPromptErrorResponse(error, code)).toEqual(__expectedResult);
    });

    it("should test formatPromptErrorResponse( mock-parameters.error 1, mock-parameters.code 2 )", () => {
      const error: Parameters<typeof formatPromptErrorResponse>[0] = "err";
      const code: Parameters<typeof formatPromptErrorResponse>[1] = "FATAL";
      const __expectedResult: ReturnType<typeof formatPromptErrorResponse> = {
        messages: [fpeMessage],
        error: "err",
        code: "FATAL",
      };
      expect(formatPromptErrorResponse(error, code)).toEqual(__expectedResult);
    });

    it("should test formatPromptErrorResponse( mock-parameters.error 1, mock-parameters.code 3 )", () => {
      const error: Parameters<typeof formatPromptErrorResponse>[0] = "err";
      const code: Parameters<typeof formatPromptErrorResponse>[1] = undefined;
      const __expectedResult: ReturnType<typeof formatPromptErrorResponse> = {
        messages: [fpeMessage],
        error: "err",
        code: "ERROR",
      };
      expect(formatPromptErrorResponse(error, code)).toEqual(__expectedResult);
    });
  });
});

// 3TG (https://3tg.dev) created 33 tests in 2524 ms (76.485 ms per generated test) @ 2026-03-27T09:53:03.816Z
