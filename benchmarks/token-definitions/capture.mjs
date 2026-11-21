import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFile, writeFile } from 'node:fs/promises';

const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: npm run capture -- /path/to/mcp.json');
const { mcpServers } = JSON.parse(await readFile(configPath, 'utf8'));
for (const name of ['dbhub', 'toolbox', 'supabase']) {
  if (!mcpServers[name]) throw new Error(`Missing server: ${name}`);
  const client = new Client({ name: 'token-benchmark', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport(mcpServers[name]));
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    if (!tools.length) throw new Error(`${name} returned no tools`);
    await writeFile(new URL(`./snapshots/${name}-tools.json`, import.meta.url), JSON.stringify({
      serverInfo: client.getServerVersion(),
      instructions: client.getInstructions(),
      tools,
    }, null, 2) + '\n');
    console.log(`${name}: ${tools.length} tools`);
  } finally {
    await client.close();
  }
}
