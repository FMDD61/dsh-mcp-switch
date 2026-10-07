/**
 * 跨进程写锁（审查 N7）。
 *
 *   node lab/lock-smoke.mjs
 *
 * 进程内已有按会话的串行链，但**两个共用同一个 DSH_HOME 的 dsh 进程之间**没有 ——
 * 两边各自读到同一份旧值、各自写回，后写的把前一次整份覆盖掉。
 *
 * 这个套件用两个真子进程对同一个文件做读-改-写来验：
 *   · locked 模式必须**一次不丢**（断言）
 *   · naive 模式作为对照跑一遍，结果只打印不断言 —— 竞态本来就是概率性的，
 *     把「它这次丢了」写成断言会得到一个偶尔变红的测试。
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./lock-child.mjs', import.meta.url));
const ITERATIONS = 40;
const PROCESSES = 2;

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok ? '' : ' -> got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)));
};

function run(mode) {
  const home = mkdtempSync(join(tmpdir(), 'mcp-switch-lock-'));
  writeFileSync(join(home, 'counter.json'), JSON.stringify({ n: 0 }));
  const children = [];
  for (let i = 0; i < PROCESSES; i += 1) {
    children.push(new Promise((resolve, reject) => {
      // stderr 收起来：子进程遇到半写文件时会记一笔，崩了也要能看见原因。
      const child = spawn(process.execPath, [CHILD, home, mode, String(ITERATIONS)], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(mode + ' child exited ' + code + ': ' + stderr.slice(0, 300)))));
    }));
  }
  return Promise.all(children).then(() => {
    const n = JSON.parse(readFileSync(join(home, 'counter.json'), 'utf8')).n;
    rmSync(home, { recursive: true, force: true });
    return n;
  });
}

const expected = ITERATIONS * PROCESSES;
console.log('两个子进程各做 ' + ITERATIONS + " 次读-改-写，期望 " + expected);

const naive = await run('naive');
console.log('  ----  naive（无锁）实际 ' + naive + (naive < expected ? '  ← 丢了 ' + (expected - naive) + ' 次更新' : '  （这次侥幸没丢）'));

const locked = await run('locked');
check('locked（withLock）一次不丢', locked, expected);

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILED');
process.exit(failures === 0 ? 0 : 1);
