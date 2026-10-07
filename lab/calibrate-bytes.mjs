import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const NAME = process.argv[2] || 'context7';
const CMD = process.argv[3] || 'npx';
const ARGS = process.argv.slice(4);
if (ARGS.length === 0) ARGS.push('-y', '@upstash/context7-mcp@latest');

const client = new Client({ name: 'calibrate', version: '0.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: CMD, args: ARGS });
await client.connect(transport);
const { tools } = await client.listTools();

const B = (s) => Buffer.byteLength(s, 'utf8');
const candidates = {
  'raw JSON.stringify(tools)': B(JSON.stringify(tools)),
  'name+description+parameters (array)': B(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })))),
  'name+description+inputSchema (array)': B(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })))),
  'sum of per-tool raw json': tools.reduce((n, t) => n + B(JSON.stringify(t)), 0),
  'sum of per-tool name+desc+schema': tools.reduce((n, t) => n + B(t.name) + B(t.description || '') + B(JSON.stringify(t.inputSchema)), 0),
  'sum of per-tool name+desc+params': tools.reduce((n, t) => n + B(t.name) + B(t.description || '') + B(JSON.stringify(t.inputSchema)), 0),
};
console.log('server=' + NAME + ' tools=' + tools.length);
for (const [k, v] of Object.entries(candidates)) console.log('  ' + String(v).padStart(7) + '  ' + k);
console.log('raw tool keys: ' + JSON.stringify(Object.keys(tools[0])));
await client.close();
process.exit(0);