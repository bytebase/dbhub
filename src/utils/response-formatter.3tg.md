# Exported functions from "src/utils/response-formatter.ts"

<!--
```json configuration
{
  "testing-framework": "vitest"
}
```
-->

## formatSuccessResponse(data: T, meta?: Record<string, any>)

These are the functional requirements for function `formatSuccessResponse`.

| test name | data     | meta      | formatSuccessResponse                          |
| --------- | -------- | --------- | ---------------------------------------------- |
|           | testData | undefined | { success:true, data:testData }                |
|           | testData | {}        | { success:true, data:testData }                |
|           | testData | testMeta  | { success:true, data:testData, meta:testMeta } |

```typescript before
const testData = {
  id: 1,
};
const testMeta = {
  affectedRows: 1,
};
```

## formatErrorResponse(error: string, code: string, details?: any)

These are the functional requirements for function `formatErrorResponse`.

| test name | error | code      | details     | formatErrorResponse                                               |
| --------- | ----- | --------- | ----------- | ----------------------------------------------------------------- |
|           | 'err' | undefined | undefined   | { success:false, error:'err', code:'ERROR' }                      |
|           | 'err' | 'ERROR'   | undefined   | { success:false, error:'err', code:'ERROR' }                      |
|           | 'err' | 'FATAL'   | undefined   | { success:false, error:'err', code:'FATAL' }                      |
|           | 'err' | undefined | testDetails | { success:false, error:'err', code:'ERROR', details:testDetails } |
|           | 'err' | 'ERROR'   | testDetails | { success:false, error:'err', code:'ERROR', details:testDetails } |
|           | 'err' | 'FATAL'   | testDetails | { success:false, error:'err', code:'FATAL', details:testDetails } |

```typescript before
const testDetails = {
  reason: 1,
};
```

## createToolErrorResponse(error: string, code: string, details?: any)

These are the functional requirements for function `createToolErrorResponse`.

| test name | error | code      | details     | createToolErrorResponse                                            |
| --------- | ----- | --------- | ----------- | ------------------------------------------------------------------ |
|           | 'err' | undefined | undefined   | {isError:true, content:[cteContent]}                               |
|           | 'err' | 'ERROR'   | undefined   | {isError:true, content:[cteContent]}                               |
|           | 'err' | 'FATAL'   | undefined   | {isError:true, content:[{...cteContent, text:ctTextFatal}]}        |
|           | 'err' | undefined | testDetails | {isError:true, content:[{...cteContent, text:ctTextErrorDetails}]} |
|           | 'err' | 'ERROR'   | testDetails | {isError:true, content:[{...cteContent, text:ctTextErrorDetails}]} |
|           | 'err' | 'FATAL'   | testDetails | {isError:true, content:[{...cteContent, text:ctTextFatalDetails}]} |

```typescript before
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
```

## createToolSuccessResponse(data: T, meta: Record<string, any>)

These are the functional requirements for function `createToolSuccessResponse`.

| test name | data     | meta      | createToolSuccessResponse                     |
| --------- | -------- | --------- | --------------------------------------------- |
|           | testData | undefined | {content:[ctsContent]}                        |
|           | testData | {}        | {content:[ctsContent]}                        |
|           | testData | testMeta  | {content:[{...ctsContent, text:ctsTextMeta}]} |

```typescript before
const ctsContent = {
  type: "text" as const,
  text: '{\n  "success": true,\n  "data": {\n    "id": 1\n  }\n}',
  mimeType: "application/json",
};
const ctsTextMeta =
  '{\n  "success": true,\n  "data": {\n    "id": 1\n  },\n  "meta": {\n    "affectedRows\": 1\n  }\n}';
```

## createResourceErrorResponse(uri: string, error: string, code: string, details?: any)

These are the functional requirements for function `createResourceErrorResponse`.

| test name | uri   | error | code      | details     | createResourceErrorResponse                           |
| --------- | ----- | ----- | --------- | ----------- | ----------------------------------------------------- |
|           | 'uri' | 'err' | undefined | undefined   | {contents:[ctrContent]}                               |
|           | 'uri' | 'err' | 'ERROR'   | undefined   | {contents:[ctrContent]}                               |
|           | 'uri' | 'err' | 'FATAL'   | undefined   | {contents:[{...ctrContent, text:ctTextFatal}]}        |
|           | 'uri' | 'err' | undefined | testDetails | {contents:[{...ctrContent, text:ctTextErrorDetails}]} |
|           | 'uri' | 'err' | 'ERROR'   | testDetails | {contents:[{...ctrContent, text:ctTextErrorDetails}]} |
|           | 'uri' | 'err' | 'FATAL'   | testDetails | {contents:[{...ctrContent, text:ctTextFatalDetails}]} |

```typescript before
const ctrContent = {
  uri: "uri",
  text: '{\n  "success": false,\n  "error": "err",\n  "code": "ERROR"\n}',
  mimeType: "application/json",
};
```

## createResourceSuccessResponse(uri: string, data: T, meta: Record<string, any>)

These are the functional requirements for function `createResourceSuccessResponse`.

| test name | uri   | data     | meta      | createResourceSuccessResponse                  |
| --------- | ----- | -------- | --------- | ---------------------------------------------- |
|           | 'uri' | testData | undefined | {contents:[crsContent]}                        |
|           | 'uri' | testData | {}        | {contents:[crsContent]}                        |
|           | 'uri' | testData | testMeta  | {contents:[{...crsContent, text:ctsTextMeta}]} |

```typescript before
const crsContent = {
  uri: "uri",
  text: '{\n  "success": true,\n  "data": {\n    "id": 1\n  }\n}',
  mimeType: "application/json",
};
```

## formatPromptSuccessResponse(text: string, references: string[])

These are the functional requirements for function `formatPromptSuccessResponse`.

| test name | text  | references     | formatPromptSuccessResponse                        |
| --------- | ----- | -------------- | -------------------------------------------------- |
|           | 'txt' | undefined      | {messages:[fpsMessage]}                            |
|           | 'txt' | []             | {messages:[fpsMessage]}                            |
|           | 'txt' | testReferences | {messages:[fpsMessage], references:testReferences} |

```typescript before
const testReferences = ["ref"];
const fpsMessage = {
  role: "assistant" as const,
  content: {
    type: "text" as const,
    text: "txt",
  },
};
```

## formatPromptErrorResponse(error: string, code: string)

These are the functional requirements for function `formatPromptErrorResponse`.

| test name | error | code      | formatPromptErrorResponse                          |
| --------- | ----- | --------- | -------------------------------------------------- |
|           | 'err' | undefined | {messages:[fpeMessage], error:'err', code:'ERROR'} |
|           | 'err' | 'ERROR'   | {messages:[fpeMessage], error:'err', code:'ERROR'} |
|           | 'err' | 'FATAL'   | {messages:[fpeMessage], error:'err', code:'FATAL'} |

```typescript before
const fpeMessage = {
  role: "assistant" as const,
  content: {
    type: "text" as const,
    text: `Error: err`,
  },
};
```

---

```json configuration
{
  "ignore": ["bigIntReplacer"]
}
```
