/**
 * 最小 MCP 服务器（stdio，行分隔 JSON-RPC 2.0）—— 只为测试，不依赖任何 server 端 SDK。
 *
 * 三个工具覆盖我们要验的三条路径：
 *   echo       —— 纯文本结果
 *   screenshot —— **真图片块**（读 lab/fixtures/test.png），验投影与附件落盘
 *   explode    —— isError:true，且正文是可操作的校验信息（验错误契约）
 *
 * stdout 只能有协议消息；任何调试输出必须走 stderr。
 *
 * 加 `--list-changed` 参数时：声明 tools.listChanged 能力，并在首次 tools/list 之后
 * 发一条 notifications/tools/list_changed，然后多暴露一个工具 —— 用来验证
 * 服务器运行期改工具列表时我们的目录会刷新（design.md §7 的 L4）。
 */

import { readFileSync } from 'node:fs';

const PNG = readFileSync(new URL('./fixtures/test.png', import.meta.url));

const LIST_CHANGED = process.argv.includes('--list-changed');

/** 首次 tools/list 之后才出现的那个工具。 */
const LATE_TOOL = { name: 'late-arrival', description: 'Appears only after the server announces a tool list change.', inputSchema: { type: 'object', properties: {} } };

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the given text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'screenshot',
    description: 'Return a small PNG image as an MCP image block.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'explode',
    description: 'Always fails with isError and an actionable message.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) return; // 通知，无需应答

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        // 回显客户端请求的版本 —— 标准的版本协商行为。
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: LIST_CHANGED ? { listChanged: true } : {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    if (publishedLate) { send({ jsonrpc: '2.0', id, result: { tools: [...TOOLS, LATE_TOOL] } }); return; }
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (LIST_CHANGED) {
      // 等客户端处理完这次应答，再宣告列表变了。
      // 刻意 **不** unref：stdin 关闭后若只靠 unref 的定时器，进程会直接退出，
      // 通知就发不出去了（实测踩到过）。
      setTimeout(() => {
        publishedLate = true;
        send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      }, 50);
    }
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'echo: ' + String(params?.arguments?.text ?? '') }] } });
      return;
    }
    if (name === 'screenshot') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            { type: 'text', text: 'here is the screenshot' },
            { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') },
          ],
        },
      });
      return;
    }
    if (name === 'late-arrival') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'the late tool ran' }] } });
      return;
    }
    if (name === 'explode') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: 'Input validation error: text: Invalid input: expected string, received undefined' }],
        },
      });
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: ' + String(name) } });
    return;
  }
  // 未实现的方法必须明确报 -32601，让客户端回退到 legacy era 而不是挂死。
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + String(method) } });
}

let publishedLate = false;
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write('fake-mcp: bad message: ' + String(error) + '\n');
    }
  }
});
