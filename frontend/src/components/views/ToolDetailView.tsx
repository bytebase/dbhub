import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, Navigate, useSearchParams } from 'react-router-dom';
import { fetchSource } from '../../api/sources';
import { executeTool, type QueryResult } from '../../api/tools';
import { ApiError } from '../../api/errors';
import { generateId } from '../../lib/utils';
import type { Tool } from '../../types/datasource';
import { SqlEditor, ParameterForm, RunButton, ResultsTabs, type ResultTab, type SqlEditorHandle } from '../tool';
import { parseParameterValues, validateParameterInput, type ParameterValues } from '../tool/ParameterForm';
import { Button } from '../ui/button';
import { PageLoading, PageLoadError } from '../WorkbenchState';
import LockIcon from '../icons/LockIcon';
import CopyIcon from '../icons/CopyIcon';
import CheckIcon from '../icons/CheckIcon';

export default function ToolDetailView() {
  const { sourceId, toolName } = useParams<{ sourceId: string; toolName: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tool, setTool] = useState<Tool | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);

  // Ref to access SqlEditor's selection
  const sqlEditorRef = useRef<SqlEditorHandle>(null);

  // Query state
  const [sql, setSql] = useState(() => {
    // Only for execute_sql tools - read from URL on mount
    return searchParams.get('sql') || '';
  });
  const [params, setParams] = useState<ParameterValues>({});
  const [resultTabs, setResultTabs] = useState<ResultTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [justCompleted, setJustCompleted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [sqlError, setSqlError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const runningRef = useRef(false);
  const runGeneration = useRef(0);
  const syncedSearch = useRef<string | null>(null);
  const hydratedTool = useRef<Tool | null>(null);

  useEffect(() => {
    if (!justCompleted) return;
    const timer = setTimeout(() => setJustCompleted(false), 2500);
    return () => clearTimeout(timer);
  }, [justCompleted]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!sourceId || !toolName) return;

    let active = true;
    runGeneration.current++;
    runningRef.current = false;
    setIsRunning(false);
    setJustCompleted(false);
    setIsLoading(true);
    setError(null);
    // Reset result state when switching tools
    setResultTabs([]);
    setActiveTabId(null);

    fetchSource(sourceId)
      .then((sourceData) => {
        if (!active) return;
        const foundTool = sourceData.tools.find((t) => t.name === toolName);
        setTool(foundTool || null);
        setIsLoading(false);
      })
      .catch((err: ApiError) => {
        if (!active) return;
        setError(err);
        setIsLoading(false);
      });
    return () => { active = false; runGeneration.current++; };
  }, [sourceId, toolName, loadAttempt]);

  // Determine tool type
  const getToolType = useCallback((): 'execute_sql' | 'search_objects' | 'custom' => {
    if (!tool) return 'custom';
    if (tool.name.startsWith('execute_sql')) return 'execute_sql';
    if (tool.name.startsWith('search_objects')) return 'search_objects';
    return 'custom';
  }, [tool]);

  const toolType = getToolType();

  // Ignore our own debounced URL writes; hydrate on navigation or a new tool.
  useEffect(() => {
    if (!tool || isLoading) return;
    const search = searchParams.toString();
    if (hydratedTool.current === tool && syncedSearch.current === search) return;
    hydratedTool.current = tool;
    syncedSearch.current = search;
    setParams(Object.fromEntries(tool.parameters.flatMap(parameter => {
      const value = searchParams.get(parameter.name);
      return value === null ? [] : [[parameter.name, value]];
    })));
    setSql(searchParams.get('sql') || '');
    setSqlError('');
    setCopyError('');
    setCopied(false);
  }, [tool, isLoading, searchParams]);

  // Update URL when sql changes (debounced for execute_sql tools)
  useEffect(() => {
    if (toolType !== 'execute_sql' || isLoading) return;

    const timer = setTimeout(() => {
      setSearchParams((currentParams) => {
        const newParams = new URLSearchParams(currentParams);

        if (sql.trim()) {
          newParams.set('sql', sql);
        } else {
          newParams.delete('sql');
        }

        syncedSearch.current = newParams.toString();
        return newParams;
      }, { replace: true });
    }, 300);

    return () => clearTimeout(timer);
  }, [sql, toolType, isLoading, setSearchParams]);

  // Update URL when params change (debounced for custom tools)
  useEffect(() => {
    if (toolType !== 'custom' || isLoading) return;

    const timer = setTimeout(() => {
      setSearchParams((currentParams) => {
        const newParams = new URLSearchParams(currentParams);

        // Clear all non-reserved params first
        Array.from(newParams.keys()).forEach(key => {
          if (key !== 'sql') {
            newParams.delete(key);
          }
        });

        // Add current param values
        Object.entries(params).forEach(([key, value]) => {
          if (value !== undefined && value !== null && value !== '') {
            newParams.set(key, String(value));
          }
        });

        syncedSearch.current = newParams.toString();
        return newParams;
      }, { replace: true });
    }, 300);

    return () => clearTimeout(timer);
  }, [params, toolType, isLoading, setSearchParams]);

  // Transform statement placeholders to named format
  const transformedStatement = useCallback((): string => {
    if (!tool?.statement) return '';
    let transformedSql = tool.statement;
    let questionMarkIndex = 0;

    // Replace $1, $2, etc. or ? with :param_name
    // For $N placeholders, use the number to look up the parameter (1-indexed)
    // For ? placeholders, use sequential order
    transformedSql = transformedSql.replace(/\$(\d+)|\?/g, (_match, num) => {
      let param;
      if (num) {
        // $N placeholder - use the number (1-indexed) to find parameter
        param = tool.parameters[parseInt(num, 10) - 1];
      } else {
        // ? placeholder - use sequential order
        param = tool.parameters[questionMarkIndex];
        questionMarkIndex++;
      }
      return param ? `:${param.name}` : ':?';
    });

    return transformedSql;
  }, [tool]);

  // Get SQL with values substituted for preview
  const getSqlPreview = useCallback((): string => {
    let sqlText = transformedStatement();

    Object.entries(parseParameterValues(tool?.parameters ?? [], params)).forEach(([name, value]) => {
      if (value !== undefined && value !== '') {
        const displayValue =
          typeof value === 'string'
            ? `'${value.replace(/'/g, "''")}'`
            : String(value);
        sqlText = sqlText.replace(new RegExp(`:${name}\\b`, 'g'), displayValue);
      }
    });

    return sqlText;
  }, [transformedStatement, params, tool]);

  // Run query
  const handleRun = useCallback(async () => {
    if (!tool || !toolName || runningRef.current) return;
    for (const parameter of tool.parameters) {
      const input = formRef.current?.elements.namedItem(parameter.name);
      if (input instanceof HTMLInputElement && parameter.type !== 'boolean') {
        validateParameterInput(input, parameter);
      }
    }
    if (!formRef.current?.checkValidity()) {
      formRef.current?.querySelector<HTMLElement>(':invalid')?.focus();
      return;
    }
    if (toolType === 'execute_sql' && !sql.trim()) {
      setSqlError('Enter a SQL statement to run.');
      sqlEditorRef.current?.focus();
      return;
    }
    runningRef.current = true;
    setIsRunning(true);
    setJustCompleted(false);

    const startTime = performance.now();
    const generation = runGeneration.current;
    const sqlToExecute = toolType === 'execute_sql'
      ? sqlEditorRef.current?.getSelectedSql() ?? sql
      : getSqlPreview();

    try {
      let queryResults: QueryResult[];

      if (toolType === 'execute_sql') {
        queryResults = await executeTool(toolName, { sql: sqlToExecute });
      } else {
        queryResults = await executeTool(toolName, parseParameterValues(tool.parameters, params));
      }

      if (generation !== runGeneration.current) return;
      const endTime = performance.now();
      const duration = endTime - startTime;
      const timestamp = new Date();
      const isBatch = queryResults.length > 1;

      // One tab per statement, so a multi-statement batch's results don't get
      // collapsed into a single tab - only the first tab's time reflects the
      // whole batch's duration, since the others didn't wait separately.
      const newTabs: ResultTab[] = queryResults.map((result, index) => ({
        id: generateId(),
        // Offset timestamps so tabs from the same run sort stably and get distinct ids/keys.
        timestamp: new Date(timestamp.getTime() + index),
        result,
        error: null,
        executedSql: result.sql ?? sqlToExecute,
        executionTimeMs: index === 0 ? duration : undefined,
        statementIndex: isBatch ? index + 1 : undefined,
        statementTotal: isBatch ? queryResults.length : undefined,
      }));
      setResultTabs(prev => [...newTabs, ...prev]);
      setActiveTabId(newTabs[0]?.id ?? null);
      setJustCompleted(true);
    } catch (err) {
      if (generation !== runGeneration.current) return;
      const errorTab: ResultTab = {
        id: generateId(),
        timestamp: new Date(),
        result: null,
        error: err instanceof Error ? err.message : 'Query failed',
        executedSql: sqlToExecute,
        executionTimeMs: performance.now() - startTime,
      };
      setResultTabs(prev => [errorTab, ...prev]);
      setActiveTabId(errorTab.id);
    } finally {
      if (generation === runGeneration.current) {
        runningRef.current = false;
        setIsRunning(false);
      }
    }
  }, [tool, toolName, toolType, sql, params, getSqlPreview]);

  const handleCopy = useCallback(async () => {
    const sqlToCopy = toolType === 'execute_sql' ? sql : getSqlPreview();
    try {
      await navigator.clipboard.writeText(sqlToCopy);
      setCopyError('');
      setCopied(true);
    } catch {
      setCopyError('Could not copy SQL. Select the statement and copy it manually.');
    }
  }, [toolType, sql, getSqlPreview]);

  const handleSqlChange = useCallback((value: string) => {
    setSql(value);
    if (value.trim()) setSqlError('');
  }, []);

  const handleTabClose = useCallback((idToClose: string) => {
    setResultTabs(prev => {
      const index = prev.findIndex(tab => tab.id === idToClose);
      const newTabs = prev.filter(tab => tab.id !== idToClose);

      if (idToClose === activeTabId && newTabs.length > 0) {
        const nextIndex = Math.min(index, newTabs.length - 1);
        setActiveTabId(newTabs[nextIndex].id);
      } else if (newTabs.length === 0) {
        setActiveTabId(null);
      }

      return newTabs;
    });
  }, [activeTabId]);

  if (!sourceId || !toolName) {
    return <Navigate to="/" replace />;
  }

  if (isLoading) return <PageLoading label="Loading tool details…" />;

  if (error) {
    if (error.status === 404) return <Navigate to="/404" replace />;
    return <PageLoadError title="Could not load this tool" message={error.message} onRetry={() => setLoadAttempt(attempt => attempt + 1)} />;
  }

  if (!tool) {
    return <Navigate to="/404" replace />;
  }

  // search_objects placeholder
  if (toolType === 'search_objects') {
    return (
      <div className="container mx-auto px-4 py-6 sm:px-8 sm:py-10 max-w-4xl">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="min-w-0 text-page text-foreground font-mono tracking-normal [overflow-wrap:anywhere]">{tool.name}</h1>
            {tool.readonly && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full whitespace-nowrap text-xs font-medium bg-warning/10 text-warning-foreground">
                <LockIcon className="w-3 h-3" />
                Read-Only
              </span>
            )}
          </div>
          <p className="text-body text-muted-foreground max-w-prose text-pretty [overflow-wrap:anywhere]">{tool.description}</p>
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
    <div className="container mx-auto px-4 py-6 sm:px-8 sm:py-10 max-w-4xl">
      <div className="space-y-6">
        {/* Header */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="min-w-0 text-page text-foreground font-mono tracking-normal [overflow-wrap:anywhere]">{tool.name}</h1>
            {tool.readonly && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full whitespace-nowrap text-xs font-medium bg-warning/10 text-warning-foreground">
                <LockIcon className="w-3 h-3" />
                Read-Only
              </span>
            )}
          </div>
          <p className="text-body text-muted-foreground max-w-prose text-pretty [overflow-wrap:anywhere]">{tool.description}</p>
        </div>

        <form ref={formRef} noValidate onSubmit={event => { event.preventDefault(); void handleRun(); }} className="space-y-6">
          {/* Parameter Form (custom tools only, show before SQL) */}
          {toolType === 'custom' && tool.parameters.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-label text-foreground">Parameters</h2>
              <div className="rounded-xl bg-card p-4 sm:p-6">
                <ParameterForm
                  key={`${sourceId}/${toolName}`}
                  parameters={tool.parameters}
                  values={params}
                  onChange={setParams}
                />
              </div>
            </div>
          )}

          {/* SQL Editor */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 id="sql-statement-label" className="text-label text-foreground">
                SQL Statement
              </h2>
              <Button
                type="button"
                variant="ghost"
                onClick={handleCopy}
                className="min-h-11 min-w-24 text-muted-foreground"
                aria-label={copied ? 'SQL copied' : 'Copy SQL'}
                title="Copy SQL"
              >
                {copied ? (
                  <>
                    <CheckIcon className="w-3.5 h-3.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <CopyIcon className="w-3.5 h-3.5" />
                    Copy
                  </>
                )}
              </Button>
            </div>
            <SqlEditor
              ref={sqlEditorRef}
              value={toolType === 'execute_sql' ? sql : getSqlPreview()}
              onChange={toolType === 'execute_sql' ? handleSqlChange : undefined}
              onRunShortcut={handleRun}
              disabled={isRunning}
              ariaLabelledBy="sql-statement-label"
              error={sqlError}
              readOnly={toolType !== 'execute_sql'}
              placeholder={
                toolType === 'execute_sql'
                  ? 'SELECT * FROM table_name LIMIT 10;'
                  : undefined
              }
            />
            {sqlError && <p id="sql-statement-error" role="alert" className="text-caption text-destructive-foreground">{sqlError}</p>}
            {copyError && <p role="alert" className="text-caption text-destructive-foreground">{copyError}</p>}
            <span role="status" className="sr-only">{copied ? 'SQL copied to clipboard.' : ''}</span>
          </div>

          {/* Run Button */}
          <div className="flex flex-wrap items-center gap-3">
            <RunButton
              onShortcut={handleRun}
              loading={isRunning}
            />
            <span role="status" className="flex items-center gap-1.5 text-caption text-muted-foreground">
              {justCompleted && <><span aria-hidden="true" className="text-query-complete"><CheckIcon /></span>Query completed</>}
            </span>
          </div>

        </form>

        {/* Results */}
        <ResultsTabs
          tabs={resultTabs}
          activeTabId={activeTabId}
          onTabSelect={setActiveTabId}
          onTabClose={handleTabClose}
          isLoading={isRunning}
          onEditQuery={() => {
            const input = formRef.current?.querySelector<HTMLElement>('input:not([type="checkbox"]), [role="checkbox"]');
            if (input) input.focus();
            else sqlEditorRef.current?.focus();
          }}
        />
      </div>
    </div>
  );
}
