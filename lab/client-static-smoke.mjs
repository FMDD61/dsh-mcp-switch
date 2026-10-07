/**
 * 浏览器半包的静态检查。
 *
 *   node lab/client-static-smoke.mjs
 *
 * 这一半是纯 JS、无构建步骤，跑不了真渲染，但能抓三类真实缺陷：
 *
 *  1. CSS 与类名映射失配 —— 加会话头部下拉时就踩过一次布局塌陷（长错误文本把
 *     重试按钮挤成两行、开关被裁掉），根因是 flex 项没写 min-width:0。
 *  2. i18n 键漏写 —— t() 的键分散在各组件里，缺一个就渲染出裸键名。
 *  3. 槽位接错 —— 头部那条要求槽位所属包（dsh-client-ui-conversation）声明在
 *     package.json 的 dsh.client.inject 里，漏了整项不渲染且不报错。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok ? '' : ' -> got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)));
};
const truthy = (label, value) => check(label, Boolean(value), true);

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const PKG = fileURLToPath(new URL('../package.json', import.meta.url));
const source = readFileSync(CLIENT, 'utf8');
const pkg = JSON.parse(readFileSync(PKG, 'utf8'));

// ---- 1. 真的把模块求值一遍，看它注册了什么 --------------------------------
let definition;
globalThis.window = { __ModuleLoader__: { load: (def) => { definition = def; } } };
await import(CLIENT);

check('module id', definition && definition.id, 'dsh-mcp-switch');

const jsxStub = (type, props) => ({ type, props });
const requireStub = (name) => {
  if (name === 'react') return { useState: () => [undefined, () => {}], useRef: () => ({ current: null }), useCallback: (f) => f, useEffect: () => {}, useLayoutEffect: () => {}, Fragment: 'Fragment' };
  if (name === 'react/jsx-runtime') return { jsx: jsxStub, jsxs: jsxStub };
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return {};
  throw new Error('unexpected require: ' + name);
};

const mod = definition.factory(requireStub);
check('exports.inject', mod.inject, ['slots', 'locale']);
truthy('exports.apply is a function', typeof mod.apply === 'function');

const injections = [];
let dictionaries;
const ctx = {
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
  get: () => undefined,
  locale: { register: (ns, dicts) => { dictionaries = { ns, dicts }; return () => {}; } },
  slots: {
    inject: (name, fn) => { injections.push({ name, fn }); return () => {}; },
    register: (options) => ({ options }),
  },
};
mod.apply(ctx);

const bands = injections.filter((i) => i.name === 'conversation.session.header.actions');
check('header band injected once', bands.length, 1);
const bandReg = bands[0].fn();
check('header band slot name', bandReg.options.name, 'conversation.session.header.actions');
check('header band entry id', bandReg.options.id, 'mcp-switch');
// 同槽位原生条目：subagent-catalog -30 / agent-team -20 / agent-preset -10 / job-list 20。
check('header band order (right of job-list)', bandReg.options.order, 30);
check('header band locale namespace', bandReg.options.locale, 'mcp-switch');

check('settings row still injected once', injections.filter((i) => i.name === 'settings.general.item').length, 1);

// ---- 2. 槽位所属包必须声明在 dsh.client.inject 里 --------------------------
const clientInject = (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || [];
truthy('dsh.client.inject declares dsh-client-ui-conversation', clientInject.indexOf('@deepseek-ai/dsh-client-ui-conversation') >= 0);
truthy('dsh.client.inject declares dsh-client-ui-primitives', clientInject.indexOf('@deepseek-ai/dsh-client-ui-primitives') >= 0);

// ---- 3. CSS 与类名映射一一对应 --------------------------------------------
const cssBlock = source.slice(source.indexOf('const CSS = ['), source.indexOf('].join', source.indexOf('const CSS = [')));
const defined = new Set([...cssBlock.matchAll(/'\.[A-Za-z0-9_]+\{/g)].map((m) => m[0].slice(2, -1)));
const mapBlock = source.slice(source.indexOf('const C = {'), source.indexOf('};', source.indexOf('const C = {')));
const mapped = new Map([...mapBlock.matchAll(/([A-Za-z0-9_]+): '([A-Za-z0-9_]+)'/g)].map((m) => [m[1], m[2]]));

check('no class mapped to an undefined rule', [...mapped.values()].filter((c) => !defined.has(c)), []);
check('no rule left unmapped', [...defined].filter((c) => ![...mapped.values()].includes(c)), []);

const referenced = new Set([...source.matchAll(/C\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
check('every C.<key> reference is defined in C', [...referenced].filter((k) => !mapped.has(k)), []);

// ---- 4. i18n 键在两个字典里都齐 --------------------------------------------
// 前面必须是标识符边界，否则 ctx.get('sessions') 这类调用会被误当成 i18n 键。
const keys = new Set([...source.matchAll(/(?:^|[^A-Za-z0-9_$])t\('([^']+)'\)/gm)].map((m) => m[1]));
const prefixes = new Set([...source.matchAll(/t\('([^']+)'\s*\+/g)].map((m) => m[1]));

const dicts = dictionaries && dictionaries.dicts;
truthy('locale.register was called', Boolean(dicts));
const zhKeys = Object.keys(dicts.zh);
const enKeys = Object.keys(dicts.en);
check('zh and en have the same key set', zhKeys.slice().sort(), enKeys.slice().sort());
check('every literal t() key exists', [...keys].filter((k) => zhKeys.indexOf(k) < 0), []);
check('every concatenated t() prefix exists', [...prefixes].filter((p) => !zhKeys.some((k) => k.indexOf(p) === 0)), []);
// 相位键是拼出来的，五个相位一个都不能缺（缺了会渲染出裸键名）。
check('all five phase keys present', ['ready', 'connecting', 'failed', 'stopped', 'closed'].filter((p) => zhKeys.indexOf('state.phase.' + p) < 0), []);

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILED');
process.exit(failures === 0 ? 0 : 1);
