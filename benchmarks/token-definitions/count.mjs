import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';

const encoder = getEncoding('cl100k_base');
// Sort keys recursively so object insertion order cannot change the result.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
const results = {};
for (const server of ['dbhub', 'toolbox', 'supabase']) {
  const snapshot = JSON.parse(await readFile(new URL(`./snapshots/${server}-tools.json`, import.meta.url), 'utf8'));
  const tools = snapshot.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const payload = JSON.stringify(canonical(tools));
  results[server] = {
    version: snapshot.serverInfo.version,
    tools: tools.length,
    tokens: encoder.encode(payload).length,
    sha256: createHash('sha256').update(payload).digest('hex'),
    perTool: Object.fromEntries(tools.map(tool => [tool.name, encoder.encode(JSON.stringify(canonical(tool))).length])),
  };
}
console.log(JSON.stringify({ encoding: 'cl100k_base', tokenizer: 'js-tiktoken@1.0.21', results }, null, 2));
