/**
 * 连接层冒烟测试：对真实 MCP 服务器（context7）跑一次完整往返。
 *
 *   node lab/connection-smoke.mjs
 *
 * 覆盖：归一化 → 连接 → tools/list → instructions → resources/list → 工具调用 →
 *       isError 形状取样 → dispose 幂等性。
 *
 * 需要插件目录下能解析到 @modelcontextprotocol/client 与 @deepseek-ai/dsh-subprocess。
 */

import { startConnection, normalizeServer } from '../lib/connection.js';

const logger = { info: (m) => console.log('  [info] ' + m), warn: (m) => console.log('  [warn] ' + m) };
const fail = (step, error) => {
  console.error('FAIL at ' + step + ': ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
};
const textOf = (result) => (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

const server = normalizeServer({
  name: 'context7',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@upstash/context7-mcp@latest'],
});
console.log('1. normalizeServer -> ' + JSON.stringify({ name: server.name, transport: server.transport, timeout: server.toolCallTimeoutMs }));

const conn = startConnection({ logger }, server);
const outcome = await conn.ready;
console.log('2. ready -> ok=' + outcome.ok + ' state=' + conn.state());
if (!outcome.ok) { fail('connect', outcome.error); process.exit(1); }

const tools = await conn.tools();
console.log('3. tools/list -> ' + tools.length + ': ' + tools.map((t) => t.name + (t.inputSchema?.required ? '(' + t.inputSchema.required.join(',') + ')' : '')).join(' | '));
console.log('4. instructions -> ' + Buffer.byteLength(conn.instructions()) + ' bytes; capabilities -> ' + JSON.stringify(Object.keys(conn.capabilities() ?? {})));

try {
  const listed = await conn.resources.list();
  console.log('5. resources/list -> ' + (listed.resources ?? []).length + ' resource(s)');
} catch (error) { console.log('5. resources/list -> refused: ' + error.message); }

// --- 6. 正常调用：两个必填参数都给 ---
const ok = await conn.callTool('resolve-library-id', { libraryName: 'react', query: 'useEffect cleanup' });
console.log('6. resolve-library-id(full args) -> isError=' + (ok.isError === true) + ' blocks=' + (ok.content ?? []).length + ' structured=' + (ok.structuredContent === undefined ? 'absent' : 'present'));
console.log('   text[0..180]: ' + JSON.stringify(textOf(ok).slice(0, 180)));

// 从返回里挑一个真实 libraryId
const ids = [...textOf(ok).matchAll(/(?:^|\s)(\/[\w.-]+\/[\w.-]+)/g)].map((m) => m[1]);
const libraryId = ids.find((id) => !/react\/react/.test(id) === false) ?? ids[0] ?? '/reactjs/react.dev';
console.log('   ids seen=' + JSON.stringify([...new Set(ids)].slice(0, 5)) + ' -> using ' + libraryId);

// --- 7. 用真实 id 查文档 ---
const docs = await conn.callTool('query-docs', { libraryId, query: 'useEffect cleanup' });
console.log('7. query-docs -> isError=' + (docs.isError === true) + ' blocks=' + (docs.content ?? []).length);
console.log('   text[0..200]: ' + JSON.stringify(textOf(docs).slice(0, 200)));

// --- 8. 缺必填参数：这是 mcp_call 错误契约的证据 ---
const missing = await conn.callTool('resolve-library-id', { libraryName: 'react' });
const missingText = textOf(missing);
console.log('8. missing required param -> isError=' + (missing.isError === true) + ' blocks=' + (missing.content ?? []).length);
console.log('   server message: ' + JSON.stringify(missingText.slice(0, 300)));
console.log('   content types: ' + JSON.stringify((missing.content ?? []).map((b) => b.type)));

// --- 9. 未知工具名：SDK 层行为 ---
try {
  const unknown = await conn.callTool('no-such-tool', {});
  console.log('9. unknown tool -> isError=' + (unknown.isError === true) + ' text=' + JSON.stringify(textOf(unknown).slice(0, 160)));
} catch (error) { console.log('9. unknown tool -> threw: ' + error.message.slice(0, 200)); }

await conn.dispose();
console.log('10. dispose -> state=' + conn.state());
try {
  await conn.callTool('resolve-library-id', { libraryName: 'x', query: 'y' });
  console.log('    ERROR: call after dispose should have thrown'); process.exitCode = 1;
} catch (error) { console.log('    call after dispose throws: ' + error.message); }
await conn.dispose();
console.log('11. dispose idempotent -> state=' + conn.state());
