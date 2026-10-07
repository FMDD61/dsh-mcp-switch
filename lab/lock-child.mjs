/**
 * lock-smoke 的子进程：对同一个文件做 N 次「读-改-写」。
 *
 *   node lab/lock-child.mjs <dshHome> <naive|locked> <iterations>
 *
 * naive   = 裸的 readFile / await 一点 / writeFile
 * locked  = 走 SessionStore.withLock（<file>.lock 兄弟文件 + rename 提交）
 *
 * 两种都先读后写，中间故意让出事件循环，好让另一个进程插进来。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [home, mode, iterationsRaw] = process.argv.slice(2);
const iterations = Number(iterationsRaw);
const file = join(home, 'counter.json');

for (let i = 0; i < iterations; i += 1) {
  const step = async () => {
    const current = JSON.parse(readFileSync(file, 'utf8')).n;
    // 让出事件循环：真实场景里这中间是磁盘 IO / 网络 / 另一个 await
    await new Promise((resolve) => setTimeout(resolve, 0));
    writeFileSync(file, JSON.stringify({ n: current + 1 }));
  };
  try {
    if (mode === 'locked') {
      const { SessionStore } = await import('../lib/store.js');
      const store = new SessionStore({ home });
      // withLock 是给「会话状态文件」用的，这里借它的锁语义测同一件事：
      // 对同一个路径的读-改-写必须互斥。
      await store.withLock('counter', step);
    } else {
      await step();
    }
  } catch {
    // 无锁模式会**真**读到半个文件（writeFileSync 非原子）—— 这正是要演示的东西。
    // 子进程不该因此崩掉：这里只记录，判定交给父进程。
    process.stderr.write('naive: lost an update\n');
  }
}
