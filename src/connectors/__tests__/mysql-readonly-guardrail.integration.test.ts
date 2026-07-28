import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MySqlContainer, type StartedMySqlContainer } from "@testcontainers/mysql";
import mysql from "mysql2/promise";
import { MySQLConnector } from "../mysql/index.js";

const DATABASE = "testdb";
const ROOT_PASSWORD = "rootpass";
const READONLY_USER = "dbhub_readonly";
const READONLY_PASSWORD = "readonlypass";

function connectionUri(
  container: StartedMySqlContainer,
  username: string,
  password: string
): string {
  return `mysql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${container.getHost()}:${container.getPort()}/${DATABASE}`;
}

describe.each(["mysql:5.7.44", "mysql:8.0.36", "mysql:8.4.10", "mysql:9.7.1"])(
  "MySQL readonly guardrail integration (%s)",
  (image) => {
    let container: StartedMySqlContainer;
    let connector: MySQLConnector;

    beforeAll(async () => {
      const containerDefinition = new MySqlContainer(image)
        .withDatabase(DATABASE)
        .withRootPassword(ROOT_PASSWORD);
      container = await (
        image === "mysql:5.7.44"
          ? containerDefinition.withPlatform("linux/amd64")
          : containerDefinition
      ).start();

      const setupConnection = await mysql.createConnection(
        connectionUri(container, "root", ROOT_PASSWORD)
      );
      try {
        await setupConnection.query(
          `CREATE USER '${READONLY_USER}'@'%' IDENTIFIED BY '${READONLY_PASSWORD}'`
        );
        await setupConnection.query(`GRANT SELECT ON \`${DATABASE}\`.* TO '${READONLY_USER}'@'%'`);
      } finally {
        await setupConnection.end();
      }

      connector = new MySQLConnector();
      await connector.connect(connectionUri(container, READONLY_USER, READONLY_PASSWORD));
    }, 180_000);

    afterAll(async () => {
      try {
        await connector?.disconnect();
      } finally {
        await container?.stop();
      }
    }, 60_000);

    it("allows ordinary readonly SQL", async () => {
      await expect(
        connector.executeSQL("SELECT 1 AS value", { readonly: true })
      ).resolves.toMatchObject({
        rows: [{ value: 1 }],
        rowCount: 1,
      });
    });

    it.each([
      "SELECT SLEEP(1)",
      "SELECT mysql.BENCHMARK(1, SHA2('x', 256))",
      "SELECT GET_LOCK('dbhub-guardrail', 0)",
      "SELECT RELEASE_LOCK('dbhub-guardrail')",
      "SELECT RELEASE_ALL_LOCKS()",
      "SELECT LOAD_FILE('/etc/hosts')",
      "SELECT SYS_EXEC('id')",
      "SELECT SYS_EVAL('id')",
      "SELECT /*!50000 SLEEP(1) */ 1",
      "SELECT `SLEEP`(1)",
      "SELECT sLeEp /* comment */ (0)",
      "SELECT mysql.\nSLEEP(0)",
      "SELECT SLEEP-- comment\n(0)",
      "SELECT SLEEP# comment\n(0)",
      "SELECT SLEEP-- comment\r\n(0)",
      "SELECT SLEEP# comment\r\n(0)",
      "SELECT 1 -- comment\r, SLEEP(0)",
      "SELECT 1 # comment\r, SLEEP(0)",
    ])("rejects %s", async (sql) => {
      await expect(connector.executeSQL(sql, { readonly: true })).rejects.toMatchObject({
        code: "MYSQL_READONLY_GUARDRAIL",
        category: "dangerous_function",
      });
    });

    it("rejects a dangerous identifier placeholder", async () => {
      await expect(
        connector.executeSQL("SELECT ??(1)", { readonly: true }, ["SLEEP"])
      ).rejects.toMatchObject({
        code: "MYSQL_READONLY_GUARDRAIL",
        category: "dangerous_function",
      });
    });

    it.each([
      "SELECT 'SLEEP(1)' AS value",
      "SELECT /* SLEEP(1) */ 1 AS value",
      "SELECT /*M! SELECT SLEEP(1) */ 1 AS value",
      "SELECT my_sleep FROM (SELECT 1 AS my_sleep) AS t",
      "SELECT IS_FREE_LOCK('dbhub-guardrail')",
      "SELECT IS_USED_LOCK('dbhub-guardrail')",
    ])("does not falsely reject %s", async (sql) => {
      await expect(connector.executeSQL(sql, { readonly: true })).resolves.toHaveProperty("rows");
    });

    it("keeps executable parameter binding after a comment-only plan", async () => {
      const result = await connector.executeSQL("/* ? */; SELECT ? AS value", { readonly: true }, [
        "ignored",
        42,
      ]);

      expect(result.rows).toEqual([{ value: 42 }]);
    });
  }
);
