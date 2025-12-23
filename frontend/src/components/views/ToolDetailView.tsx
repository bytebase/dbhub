import { useEffect, useState, useCallback } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { fetchSource } from '../../api/sources';
import { executeTool, type QueryResult } from '../../api/tools';
import { ApiError } from '../../api/errors';
import type { Tool } from '../../types/datasource';
import { SqlEditor, ParameterForm, RunButton, ResultsTable } from '../tool';

export default function ToolDetailView() {
  const { sourceId, toolName } = useParams<{ sourceId: string; toolName: string }>();
  const [tool, setTool] = useState<Tool | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  // Query state
  const [sql, setSql] = useState('');
  const [params, setParams] = useState<Record<string, any>>({});
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    if (!sourceId || !toolName) return;

    setIsLoading(true);
    setError(null);

    fetchSource(sourceId)
      .then((source) => {
        const foundTool = source.tools.find((t) => t.name === toolName);
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
  const handleRun = async () => {
    if (!tool || !toolName) return;

    setIsRunning(true);
    setQueryError(null);
    setResult(null);

    try {
      let queryResult: QueryResult;

      if (toolType === 'execute_sql') {
        queryResult = await executeTool(toolName, { sql });
      } else {
        queryResult = await executeTool(toolName, params);
      }

      setResult(queryResult);
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : 'Query failed');
    } finally {
      setIsRunning(false);
    }
  };

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
          <h1 className="text-3xl font-bold text-foreground font-mono">{tool.name}</h1>
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
          <h1 className="text-3xl font-bold text-foreground font-mono">{tool.name}</h1>
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
        <ResultsTable result={result} error={queryError} isLoading={isRunning} />
      </div>
    </div>
  );
}
