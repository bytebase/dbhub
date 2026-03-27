# Exported functions from "src/utils/multi-statement-result-parser.ts"

<!--
```json configuration
{
  "testing-framework": "vitest"
}
```
-->

## extractRowsFromMultiStatement(multiStmntResults: any)

These are the functional requirements for function `extractRowsFromMultiStatement`.

| test name | multiStmntResults                 | extractRowsFromMultiStatement |
| --------- | --------------------------------- | ----------------------------- |
|           | undefined                         | []                            |
|           | 'abc'                             | []                            |
|           | 123                               | []                            |
|           | true                              | []                            |
|           | []                                | []                            |
|           | [[], []]                          | []                            |
|           | [{ affectedRows:1, insertId:0 }]  | []                            |
|           | [{ affectedRows:1 }, [{ id:99 }]] | [{ id: 99 }]                  |
|           | [[{ id:1, name:'Alice' }]]        | [{ id:1, name:'Alice' }]      |
|           | [[{ id:1 }], [{ id:2 }]]          | [{ id:1 }, { id:2 }]          |
|           | [[1, 2], { meta:true }, [3]]      | [1,2,3]                       |
|           | { data: [1,2,3] }                 | []                            |

## extractAffectedRows(affectedRows: any)

These are the functional requirements for function `extractAffectedRows`.

| test name | affectedRows                                | extractAffectedRows |
| --------- | ------------------------------------------- | ------------------- |
|           | undefined                                   | 0                   |
|           | 'error'                                     | 0                   |
|           | { affectedRows:5, insertId:1 }              | 5                   |
|           | { insertId:1 }                              | 0                   |
|           | []                                          | 0                   |
|           | [[]]                                        | 0                   |
|           | [{ id:1 }, { id:2 }]                        | 2                   |
|           | [[{ id:1 }], [{ id:2 }, { id:3 }]]          | 3                   |
|           | [{ affectedRows:10 }, { affectedRows:5 }]   | 15                  |
|           | [{ affectedRows: 1 }, [{ id:1 }, { id:2 }]] | 3                   |
|           | [[{ id:1 }], []]                            | 1                   |
|           | [{ warningStatus:1, affectedRows:2 }]       | 2                   |

## parseQueryResults(queryResults: any)

These are the functional requirements for function `parseQueryResults`.

| test name | queryResults                         | parseQueryResults    |
| --------- | ------------------------------------ | -------------------- |
|           | undefined                            | []                   |
|           | 123                                  | []                   |
|           | { affectedRows:1 }                   | []                   |
|           | []                                   | []                   |
|           | [{ id:1 }, { id:2 }]                 | [{ id:1 }, { id:2 }] |
|           | [[{ id:1 }], [{ id:2 }]]             | [{ id:1 }, { id:2 }] |
|           | [{ affectedRows:1 }, [{ id:5 }]]     | [{ id:5 }]           |
|           | [{ affectedRows:1 }, { insertId:2 }] | []                   |
|           | [{ warningStatus:0 }, [{ id:1 }]]    | [{ id:1 }]           |
