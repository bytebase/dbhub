## Database Access

This project provides an MCP server (DBHub) for secure SQL access to the development database.

AI agents explore the schema with `search_objects` and run SQL with `execute_sql`. With a read-only tool configuration (recommended for production):

- `SELECT * FROM users LIMIT 5;`
- `SHOW TABLES;`
- `DESCRIBE table_name;`

With a writable tool configuration (development/testing):

- `INSERT INTO users (name, email) VALUES ('John', 'john@example.com');`
- `UPDATE users SET status = 'active' WHERE id = 1;`
- `CREATE TABLE test_table (id INT PRIMARY KEY);`

Read-only mode is set per tool in a TOML config file loaded with `--config` (there is no `--readonly` flag):

```toml
[[sources]]
id = "default"
dsn = "postgres://user:password@localhost:5432/dbname"

[[tools]]
name = "execute_sql"
source = "default"
readonly = true
```

See https://dbhub.ai/config/read-only-mode for how it is enforced on each database.
