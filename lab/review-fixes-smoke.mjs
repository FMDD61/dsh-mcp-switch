/**
 * 发布前审查的修复回归（2026-10-07）。
 *
 *   node lab/review-fixes-smoke.mjs
 *
 * 只测审查报告里点名的、**能直接测到**的几条。测不到的写在末尾（诚实的覆盖缺口）。
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'mcp-switch-review-'));
process.env.DSH_HOME = HOME;

const { describeFailure } = await import('../lib/connection.js');
const { projectMcpContent } = await import('../lib/projection.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok ? '' : ' -> got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)));
};
const truthy = (label, value) => check(label, Boolean(value), true);

// ───────────────── 1. S3：连接失败要把 cause 链带出来 ─────────────────
console.log('1. S3 连接失败的诊断（原先只报 "fetch failed"）');
{
  const bare = new Error('fetch failed');
  check('没有 cause 时保持原样', describeFailure(bare), 'fetch failed');

  const withCode = new Error('fetch failed');
  withCode.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  check('带 code 的 cause 被拼上', describeFailure(withCode), 'fetch failed (ECONNREFUSED)');

  const nested = new Error('fetch failed');
  const mid = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
  mid.cause = Object.assign(new Error('dns lookup failed'), { code: 'EAI_AGAIN' });
  nested.cause = mid;
  const text = describeFailure(nested);
  truthy('多层 cause 都出来', text.includes('ENOTFOUND') && text.includes('EAI_AGAIN'));
  truthy('单行（不产生多行日志）', !text.includes(String.fromCharCode(10)));

  // 环形 cause 不能转死
  const loop = new Error('a');
  const other = new Error('b');
  loop.cause = other;
  other.cause = loop;
  truthy('环形 cause 不死循环', describeFailure(loop).length < 200);
}

// ───────────────── 2. S6：空 content 不能什么都不给 ─────────────────
console.log(String.fromCharCode(10) + '2. S6 空产出（原先模型看到一片空白）');
{
  const ctx = { logger: { warn: () => {}, error: () => {}, info: () => {} } };
  const exec = { agent: { session: { header: { id: 's1' } } }, signal: new AbortController().signal };

  const empty = await projectMcpContent(ctx, exec, []);
  check('空数组产出一条占位', empty.length, 1);
  check('占位是文本块', empty[0].type, 'text');
  truthy('占位文本说明了情况', /no model-visible content/i.test(empty[0].text));

  // 不认识的块类型本来就有占位；两者不能重复叠加
  const unknown = await projectMcpContent(ctx, exec, [{ type: 'nonsense' }]);
  check('不认识的块仍然一条', unknown.length, 1);

  // 正常文本不受影响
  const text = await projectMcpContent(ctx, exec, [{ type: 'text', text: 'hello' }]);
  check('正常文本原样', text, [{ type: 'text', text: 'hello' }]);
}

// ───────────────── 3. B2：peer 范围必须同时认 rc.2 与 0.2.1-alpha ─────────────────
console.log(String.fromCharCode(10) + '3. B2 peer 范围');
{
  const semver = (await import('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/semver/index.js')).default;
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const ranges = Object.values(pkg.peerDependencies);
  check('三个 peer 包', ranges.length, 3);
  for (const version of ['0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha', '0.2.1']) {
    check('范围认 ' + version, ranges.every((r) => semver.satisfies(version, r)), true);
  }
  for (const version of ['0.3.0-rc.1', '0.3.0']) {
    check('范围排除 ' + version, ranges.every((r) => !semver.satisfies(version, r)), true);
  }
}

// ───────────────── 4. 失效即响亮：预设隔离失败必须用 error 级 ─────────────────
console.log(String.fromCharCode(10) + '4. 预设隔离失败不能静默');
{
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  truthy('restrict 失败走 logger.error', source.includes('preset isolation is NOT in effect'));
  truthy('不再用 warn 吞掉', !/cannot hide tools[\s\S]{0,120}logger\?\.warn/.test(source));
}

// ───────────────── 5. S8 canary：宿主契约（我们整个预设隔离就架在这两条上）─────────────────
console.log(String.fromCharCode(10) + '5. S8 canary —— dsh 的 tools.restrict 契约');
{
  // 真实机制已由**用户端到端验收**过（极简模式工具表干净、PTC 模式三个工具可用）。
  // 这里钉的是它赖以成立的两条宿主事实 —— dsh 一旦改动，这个测试要**响亮地失败**，
  // 而不是等用户在极简模式里重新看到三个工具。
  const { existsSync } = await import('node:fs');
  const candidates = [
    '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
  ];
  const source = candidates.find((p) => existsSync(p));
  if (source === undefined) {
    console.log('  skip  dsh-tools 不在预期位置（非本机布局），跳过 canary');
  } else {
    const text = readFileSync(source, 'utf8');
    const collector = text.indexOf('const restrictableNames');
    const addSite = text.indexOf('restrictableNames.add(name)');
    const ownLoop = text.indexOf('if (own !== void 0) for (const [name] of own.tools.entries())');

    truthy('restrictableNames 仍在（名字没变）', collector >= 0);
    truthy('收集点仍存在', addSite >= 0);
    truthy('restrict() 仍对未知名字抛错', text.includes('names unknown global tool'));
    truthy('仍要求 scoped context', text.includes('requires a scoped context (agent.ctx)'));

    // **关键**：全局层的名字必须可限制。收集点必须落在 inherited 循环里，
    // 也就是**早于** own 循环 —— 落到 own 里就意味着「只有本 scope 注册的才可限制」，
    // 而我们是全局注册，届时 restrict 会抛 unknown global tool。
    truthy('收集点在 own 循环之前（全局名可限制）', collector >= 0 && addSite > collector && (ownLoop < 0 || addSite < ownLoop));
  }
}

// ───────────────── 覆盖缺口（诚实记下来，没测到就是没测到）─────────────────
console.log(String.fromCharCode(10) + '覆盖缺口（本套件没测，别当成测过了）：');
console.log('  · S1/S2 的防御性拷贝：Read 端在 JSON 边界之后，观察不到别名，只能靠审读');
console.log('  · S8 的真实 tools.restrict：本套件只钉宿主契约（canary），不跑真作用域；' + String.fromCharCode(10) + '    真正的端到端已由用户在极简/PTC 两个模式实测过');
console.log('  · /mcp-switch/default 端点、sessionProjections 分支：仍未覆盖');

rmSync(HOME, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILED');
process.exit(failures === 0 ? 0 : 1);
