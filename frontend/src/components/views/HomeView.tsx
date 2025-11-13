export default function HomeView() {
  return (
    <div className="container mx-auto px-8 py-12 max-w-4xl">
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold text-foreground mb-4">
            Welcome to DBHub
          </h1>
          <p className="text-xl text-muted-foreground">
            Universal Database MCP Server
          </p>
        </div>

        <div className="prose prose-slate dark:prose-invert max-w-none">
          <h2 className="text-2xl font-semibold text-foreground mb-3">
            What is DBHub?
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            DBHub is a Universal Database MCP Server that implements the Model Context Protocol (MCP)
            interface. It bridges MCP-compatible clients (like Claude Desktop, Claude Code, and Cursor)
            with various database systems including PostgreSQL, MySQL, MariaDB, SQL Server, and SQLite.
          </p>
        </div>

        <div className="prose prose-slate dark:prose-invert max-w-none">
          <h2 className="text-2xl font-semibold text-foreground mb-3">
            Getting Started
          </h2>
          <div className="space-y-4 text-muted-foreground">
            <div>
              <h3 className="text-lg font-medium text-foreground mb-2">1. Configure Data Sources</h3>
              <p className="leading-relaxed">
                Set up your database connections using the <code className="px-2 py-1 bg-muted rounded text-sm">dbhub.toml</code> file
                or environment variables. Each data source can be configured with connection details,
                read-only restrictions, and row limits.
              </p>
            </div>

            <div>
              <h3 className="text-lg font-medium text-foreground mb-2">2. Explore Your Databases</h3>
              <p className="leading-relaxed">
                Select a data source from the sidebar to view its connection status, configuration,
                and metadata. You can see details like host, port, database name, and connection settings.
              </p>
            </div>

            <div>
              <h3 className="text-lg font-medium text-foreground mb-2">3. Connect via MCP Clients</h3>
              <p className="leading-relaxed">
                Use DBHub with MCP-compatible clients like Claude Desktop or Claude Code to query your databases,
                explore schemas, and perform database operations using natural language.
              </p>
            </div>
          </div>
        </div>

        <div className="bg-muted rounded-lg p-6">
          <h2 className="text-xl font-semibold text-foreground mb-3">
            Key Features
          </h2>
          <ul className="space-y-2 text-muted-foreground">
            <li className="flex items-start gap-2">
              <span className="text-primary mt-1">•</span>
              <span>Support for multiple database systems (PostgreSQL, MySQL, MariaDB, SQL Server, SQLite)</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-1">•</span>
              <span>Multi-database configuration with unique source IDs</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-1">•</span>
              <span>SSH tunnel support for secure connections through bastion hosts</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-1">•</span>
              <span>Read-only mode and row limit controls for safety</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-1">•</span>
              <span>RESTful API for inspecting data source configurations</span>
            </li>
          </ul>
        </div>

        <div className="border-t border-border pt-6">
          <p className="text-sm text-muted-foreground">
            For more information, visit the{' '}
            <a
              href="https://github.com/bytebase/dbhub"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              DBHub GitHub repository
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
