import { useEffect, useState, useCallback } from 'react';
import { useParams, Navigate, useSearchParams } from 'react-router-dom';
import { fetchSource } from '../../api/sources';
import { executeTool, type QueryResult } from '../../api/tools';
import { ApiError } from '../../api/errors';
import type { Tool } from '../../types/datasource';
import { SqlEditor, ParameterForm, RunButton, ResultsTable } from '../tool';
import LockIcon from '../icons/LockIcon';

export default function ToolDetailView() {
  const { sourceId, toolName } = useParams<{ sourceId: string; toolName: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tool, setTool] = useState<Tool | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  // Query state
  const [sql, setSql] = useState(() => {
    // Only for execute_sql tools - read from URL on mount
    return searchParams.get('sql') || '';
  });
  const [params, setParams] = useState<Record<string, any>>({});
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [executionTimeMs, setExecutionTimeMs] = useState<number | null>(null);
  const [executedSql, setExecutedSql] = useState<string>('');

  useEffect(() => {
    if (!sourceId || !toolName) return;

    setIsLoading(true);
    setError(null);

    fetchSource(sourceId)
      .then((sourceData) => {
        const foundTool = sourceData.tools.find((t) => t.name === toolName);
        setTool(foundTool || null);
        setIsLoading(false);
      })
      .catch((err: ApiError) => {
        setError(err);
        setIsLoading(false);
      });
  }, [sourceId, toolName]);

  // Determine tool type
  const getToolType = useCallback((): 'execute_sql' | 'search_objects' | 'custom' => {
    if (!tool) return 'custom';
    if (tool.name.startsWith('execute_sql')) return 'execute_sql';
    if (tool.name.startsWith('search_objects')) return 'search_objects';
    return 'custom';
  }, [tool]);

  const toolType = getToolType();

  // Coerce URL parameter values to correct types based on parameter schema
  const coerceParamValue = useCallback((value: string, paramName: string): any => {
    if (!tool) return value;

    const paramDef = tool.parameters.find(p => p.name === paramName);
    if (!paramDef) return undefined; // Invalid param - will be filtered out

    // Type coercion based on parameter schema
    if (paramDef.type === 'number' || paramDef.type === 'integer' || paramDef.type === 'float') {
      const num = Number(value);
      return isNaN(num) ? '' : num;
    }
    if (paramDef.type === 'boolean') {
      return value === 'true';
    }
    return value; // string type
  }, [tool]);

  // Coerce URL params to correct types after tool is loaded
  useEffect(() => {
    if (!tool || toolType !== 'custom') return;

    // Only coerce params from URL on initial mount
    const urlParams: Record<string, any> = {};
    searchParams.forEach((value, key) => {
      if (key !== 'sql') {
        const coerced = coerceParamValue(String(value), key);
        if (coerced !== undefined) {
          urlParams[key] = coerced;
        }
      }
    });

    // Only update if we have URL params to coerce
    if (Object.keys(urlParams).length > 0) {
      setParams(urlParams);
    }
  }, [tool, toolType, searchParams, coerceParamValue]);

  // Update URL when sql changes (debounced for execute_sql tools)
  useEffect(() => {
    if (toolType !== 'execute_sql') return;

    const timer = setTimeout(() => {
      const newParams = new URLSearchParams(searchParams);

      if (sql.trim()) {
        newParams.set('sql', sql);
      } else {
        newParams.delete('sql');
      }

      setSearchParams(newParams, { replace: true });
    }, 300);

    return () => clearTimeout(timer);
  }, [sql, toolType, searchParams, setSearchParams]);

  // Update URL when params change (debounced for custom tools)
  useEffect(() => {
    if (toolType !== 'custom') return;

    const timer = setTimeout(() => {
      const newParams = new URLSearchParams();

      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== '') {
          newParams.set(key, String(value));
        }
      });

      setSearchParams(newParams, { replace: true });
    }, 300);

    return () => clearTimeout(timer);
  }, [params, toolType, setSearchParams]);

  // Transform statement placeholders to named format
  const transformedStatement = useCallback((): string => {
    if (!tool?.statement) return '';
    let transformedSql = tool.statement;
    let placeholderIndex = 0;

    // Replace $1, $2, etc. or ? with :param_name
    transformedSql = transformedSql.replace(/\$\d+|\?/g, () => {
      const param = tool.parameters[placeholderIndex];
      placeholderIndex++;
      return param ? `:${param.name}` : ':?';
    });

    return transformedSql;
  }, [tool]);

  // Get SQL with values substituted for preview
  const getSqlPreview = useCallback((): string => {
    let sqlText = transformedStatement();

    Object.entries(params).forEach(([name, value]) => {
      if (value !== undefined && value !== '') {
        const displayValue =
          typeof value === 'string'
            ? `'${value.replace(/'/g, "''")}'`
            : String(value);
        sqlText = sqlText.replace(new RegExp(`:${name}\\b`, 'g'), displayValue);
      }
    });

    return sqlText;
  }, [transformedStatement, params]);

  // Check if all required params are filled
  const allRequiredParamsFilled = useCallback((): boolean => {
    if (!tool) return false;
    return tool.parameters
      .filter((p) => p.required)
      .every((p) => params[p.name] !== undefined && params[p.name] !== '');
  }, [tool, params]);

  // Run query
  const handleRun = useCallback(async () => {
    if (!tool || !toolName) return;

    setIsRunning(true);
    setQueryError(null);
    setResult(null);
    setExecutionTimeMs(null);

    const startTime = performance.now();

    try {
      let queryResult: QueryResult;
      let sqlToExecute: string;

      if (toolType === 'execute_sql') {
        sqlToExecute = sql;
        queryResult = await executeTool(toolName, { sql });
      } else {
        sqlToExecute = getSqlPreview();
        queryResult = await executeTool(toolName, params);
      }

      const endTime = performance.now();
      const duration = endTime - startTime;

      setResult(queryResult);
      setExecutionTimeMs(duration);
      setExecutedSql(sqlToExecute);
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : 'Query failed');
    } finally {
      setIsRunning(false);
    }
  }, [tool, toolName, toolType, sql, params, getSqlPreview]);

  // Compute disabled state for run button
  const isRunDisabled =
    toolType === 'execute_sql' ? !sql.trim() : !allRequiredParamsFilled();

  if (!sourceId || !toolName) {
    return <Navigate to="/" replace />;
  }

  if (isLoading) {
    return (
      <div className="container mx-auto px-8 py-12">
        <div className="text-muted-foreground">Loading tool details...</div>
      </div>
    );
  }

  if (error) {
    if (error.status === 404) {
      return <Navigate to="/404" replace />;
    }

    return (
      <div className="container mx-auto px-8 py-12">
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-destructive mb-2">Error</h2>
          <p className="text-destructive/90">{error.message}</p>
        </div>
      </div>
    );
  }

  if (!tool) {
    return <Navigate to="/404" replace />;
  }

  // search_objects placeholder
  if (toolType === 'search_objects') {
    return (
      <div className="container mx-auto px-8 py-12 max-w-4xl">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-foreground font-mono">{tool.name}</h1>
            {tool.readonly && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
                <LockIcon className="w-3 h-3" />
                Read-Only
              </span>
            )}
          </div>
          <p className="text-muted-foreground leading-relaxed">{tool.description}</p>
          <div className="border border-border rounded-lg bg-card p-8 text-center">
            <p className="text-muted-foreground">
              Interactive UI for this tool is coming soon.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-8 py-12 max-w-4xl">
      <div className="space-y-6">
        {/* Header */}
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-foreground font-mono">{tool.name}</h1>
            {tool.readonly && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
                <LockIcon className="w-3 h-3" />
                Read-Only
              </span>
            )}
          </div>
          <p className="text-muted-foreground leading-relaxed">{tool.description}</p>
        </div>

        {/* Parameter Form (custom tools only, show before SQL) */}
        {toolType === 'custom' && tool.parameters.length > 0 && (
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Parameters</label>
            <div className="border border-border rounded-lg bg-card p-4">
              <ParameterForm
                parameters={tool.parameters}
                values={params}
                onChange={setParams}
              />
            </div>
          </div>
        )}

        {/* SQL Editor */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {toolType === 'execute_sql' ? 'SQL Query' : 'SQL Statement'}
          </label>
          <SqlEditor
            value={toolType === 'execute_sql' ? sql : getSqlPreview()}
            onChange={toolType === 'execute_sql' ? setSql : undefined}
            onRunShortcut={handleRun}
            disabled={isRunDisabled || isRunning}
            readOnly={toolType !== 'execute_sql'}
            placeholder={
              toolType === 'execute_sql'
                ? 'SELECT * FROM table_name LIMIT 10;'
                : undefined
            }
          />
        </div>

        {/* Run Button */}
        <RunButton
          onClick={handleRun}
          disabled={isRunDisabled}
          loading={isRunning}
        />

        {/* Results */}
        <ResultsTable
          result={result}
          error={queryError}
          isLoading={isRunning}
          executedSql={executedSql}
          executionTimeMs={executionTimeMs ?? undefined}
        />
      </div>
    </div>
  );
}
