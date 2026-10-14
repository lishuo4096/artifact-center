// 离线自检：不需要 harness 就能验证宿主路由 / 工具 / 客户端渲染三条路径。
// 运行：node test/local-smoke.mjs
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');

let failures = 0;
function check(name, ok, extra = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

// ── 1. 宿主半边 ────────────────────────────────────────────────────────────
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-center-'));
const srcDir = path.join(root, 'src');
await fs.mkdir(srcDir, { recursive: true });
const samples = [
  ['报告.pdf', 'pdf'],
  ['数据.xlsx', 'xlsx'],
  ['脚本.py', 'py'],
];
for (const [name, ext] of samples) {
  await fs.writeFile(path.join(srcDir, name), `content of ${ext}`);
}

const mod = await import(pathToFileURL(path.join(pkgDir, 'index.js')).href);

const tools = new Map();
const routes = new Map();
const fakeWebCtx = {
  effect: (fn) => fn(),
  webServer: {
    register: (route) => {
      routes.set(`${route.kind}:${route.path}`, route);
      return () => {};
    },
  },
};
const ctx = {
  tools: { register: (tool) => tools.set(tool.name, tool) },
  effect: (fn) => fn(),
  inject: (deps, cb) => {
    if (deps.includes('webServer')) cb(fakeWebCtx);
  },
};

mod.apply(ctx, { rootDir: root });

console.log('宿主: 插件壳');
check('导出 name', mod.name === 'artifact-center', String(mod.name));
check('applied 后注册 4 个工具', tools.size === 4, [...tools.keys()].join(','));
check('注册 3 条数据路由', routes.size === 3, [...routes.keys()].join(' | '));

// ── 宿主子集校验的复刻 ──────────────────────────────────────────────────────
// 线上事故根因：ctx.tools.register() 会拿 output.schema 过 assertSupportedJsonSchema
// （dsh-tools/lib/index.js:2878 → :323），而 SCHEMA_TYPES(:50) 里没有 "json"
// —— 作者侧写法的 {type:'json'} 必须先被 defineTool 编译成无约束的 {}。
// 这里复刻同一套规则，保证「注册期就该被拒的 schema」在离线自检里直接暴露。
const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
function schemaViolations(node, p = 'schema', out = []) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    out.push(`${p} 必须是对象 schema`);
    return out;
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue;
    out.push(`${p}.${key} 不是受支持的关键字`);
  }
  const hasType = Object.hasOwn(node, 'type');
  const hasOneOf = Object.hasOwn(node, 'oneOf');
  if (hasType && hasOneOf) {
    out.push(`${p} 不能同时声明 type 与 oneOf`);
    return out;
  }
  if (!hasType && !hasOneOf) return out; // 无 type/oneOf = 无约束 JSON：宿主接受
  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) out.push(`${p}.oneOf 至少两个分支`);
    else node.oneOf.forEach((b, i) => schemaViolations(b, `${p}.oneOf[${i}]`, out));
    return out;
  }
  if (!SCHEMA_TYPES.has(node.type)) {
    out.push(`${p}.type 必须是 ${[...SCHEMA_TYPES].join('/')} 之一，收到 ${JSON.stringify(node.type)}`);
    return out;
  }
  const placement = {
    properties: ['object'],
    required: ['object'],
    additionalProperties: ['object'],
    items: ['array'],
    enum: ['string', 'number', 'integer', 'boolean', 'null'],
    const: ['string', 'number', 'integer', 'boolean', 'null'],
  };
  for (const [key, types] of Object.entries(placement)) {
    if (Object.hasOwn(node, key) && !types.includes(node.type)) out.push(`${p}.${key} 不能挂在 type "${node.type}" 上`);
  }
  if (node.type === 'object' && node.properties !== undefined) {
    if (typeof node.properties !== 'object' || node.properties === null || Array.isArray(node.properties)) {
      out.push(`${p}.properties 必须是对象`);
    } else {
      for (const [k, v] of Object.entries(node.properties)) schemaViolations(v, `${p}.properties.${k}`, out);
    }
  }
  if (node.type === 'array' && Object.hasOwn(node, 'items')) schemaViolations(node.items, `${p}.items`, out);
  return out;
}

console.log('宿主: 工具定义必须能过宿主 schema 子集校验');
for (const [name, tool] of tools) {
  const badOut = schemaViolations(tool.output?.schema, `${name}.output.schema`);
  check(`${name} output.schema 合法`, badOut.length === 0, badOut.join('; '));
  const badPar = schemaViolations(tool.parameters, `${name}.parameters`);
  check(`${name} parameters 是对象根 JSON Schema`, badPar.length === 0 && tool.parameters.type === 'object' && typeof tool.parameters.properties === 'object', badPar.join('; '));
  check(`${name} 未把作者侧 type:"json" 透传给宿主`, !JSON.stringify({ p: tool.parameters, s: tool.output.schema }).includes('"json"'));
}
check('artifact_save.parameters.required = ["path"]', JSON.stringify(tools.get('artifact_save').parameters.required) === '["path"]', JSON.stringify(tools.get('artifact_save').parameters.required));
check('artifact_save.parameters.properties.tags 为 array<string>', tools.get('artifact_save').parameters.properties.tags.type === 'array' && tools.get('artifact_save').parameters.properties.tags.items.type === 'string');
check('artifact_save.parameters.properties.mode 保留 string', tools.get('artifact_save').parameters.properties.mode.type === 'string');
check('artifact_save.output.schema 编译为无约束 {}', JSON.stringify(tools.get('artifact_save').output.schema) === '{}', JSON.stringify(tools.get('artifact_save').output.schema));
check('artifact_list 无必填参数', tools.get('artifact_list').parameters.required === undefined, JSON.stringify(tools.get('artifact_list').parameters.required));
check('artifact_remove.parameters.required = ["id"]', JSON.stringify(tools.get('artifact_remove').parameters.required) === '["id"]');
check('artifact_stats.parameters 为空对象属性表', JSON.stringify(tools.get('artifact_stats').parameters) === '{"type":"object","properties":{}}', JSON.stringify(tools.get('artifact_stats').parameters));
// 参数校验语义：必填缺失应抛 ToolArgsError，而不是静默把 undefined 传下去
let argErr = null;
try {
  await tools.get('artifact_save').execute({}, {});
} catch (e) {
  argErr = e;
}
check('缺 path 时抛 ToolArgsError(INVALID_ARGS)', argErr !== null && argErr.code === 'INVALID_ARGS' && /path/.test(argErr.message), argErr ? argErr.message : 'no throw');
let typeErr = null;
try {
  await tools.get('artifact_save').execute({ path: 42, tags: 'nope' }, {});
} catch (e) {
  typeErr = e;
}
check('类型错误时抛 ToolArgsError', typeErr !== null && typeErr.code === 'INVALID_ARGS', typeErr ? typeErr.message : 'no throw');

console.log('宿主: 工具');
const saved = [];
for (const [name] of samples) {
  const value = await tools.get('artifact_save').execute({ path: path.join(srcDir, name) }, {});
  saved.push(value);
  check(`artifact_save ${name}`, value.ok === true, JSON.stringify(value));
}
const listAll = await tools.get('artifact_list').execute({}, {});
check('artifact_list 返回 3 条', Array.isArray(listAll) && listAll.length === 3, JSON.stringify(listAll).slice(0, 120));
const listPy = await tools.get('artifact_list').execute({ ext: 'py' }, {});
check('artifact_list ext=py 命中 1 条', listPy.length === 1 && listPy[0].ext === 'py');
const listCode = await tools.get('artifact_list').execute({ category: 'code' }, {});
check('artifact_list category=code 命中 1 条', listCode.length === 1);
const listKw = await tools.get('artifact_list').execute({ keyword: '报告' }, {});
check('artifact_list keyword 命中 1 条', listKw.length === 1);
const stats = await tools.get('artifact_stats').execute({}, {});
check('artifact_stats 计数正确', stats.total === 3 && stats.byCategory.pdf === 1 && stats.byExt.xlsx === 1, JSON.stringify(stats));
check('copy 模式副本已落盘', await fs.access(saved[0].item.storedPath).then(() => true, () => false));
check('副本在原文件之外', !saved[0].item.storedPath.startsWith(srcDir));

const linkValue = await tools.get('artifact_save').execute({ path: path.join(srcDir, '报告.pdf'), mode: 'link', title: '仅登记' }, {});
check('link 模式不复制', linkValue.item.storedPath === linkValue.item.originalPath, linkValue.item.storedPath);
const afterRemove = await tools.get('artifact_remove').execute({ id: linkValue.item.id }, {});
check('artifact_remove link 条目成功', afterRemove.ok === true);
check('link 模式删除不动原文件', await fs.access(path.join(srcDir, '报告.pdf')).then(() => true, () => false));
const bad = await tools.get('artifact_save').execute({ path: path.join(srcDir, '不存在.pdf') }, {});
check('不存在的路径返回 ok:false 而不抛', bad.ok === false && typeof bad.message === 'string', JSON.stringify(bad));

// 假 req / res
function fakeRes() {
  const out = { status: 0, headers: null, body: '' };
  return {
    out,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers;
    },
    end(body) {
      out.body = body ?? '';
    },
  };
}
function fakeReq(url, method = 'GET', payload, headers = {}) {
  const req = payload === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(payload))]);
  req.url = url;
  req.method = method;
  req.headers = {
    ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers,
  };
  return req;
}

console.log('宿主: webserver 路由');
const stateRoute = routes.get('exact:/artifact-center/api/state');
const res1 = fakeRes();
await stateRoute.handler(fakeReq('/artifact-center/api/state'), res1);
let payload = JSON.parse(res1.out.body);
check('state 路由 200', res1.out.status === 200);
check('state 路由返回 items/stats/rootDir/categories',
  Array.isArray(payload.items) && payload.stats && payload.rootDir === root && Array.isArray(payload.categories),
  JSON.stringify(Object.keys(payload)));
check('state 路由 items 已含 3 条', payload.items.length === 3, String(payload.items.length));

const res2 = fakeRes();
await stateRoute.handler(fakeReq('/artifact-center/api/state?category=excel'), res2);
payload = JSON.parse(res2.out.body);
check('state 路由支持 category 过滤', payload.items.length === 1 && payload.items[0].category === 'excel');
check('state 路由 stats 不受过滤影响', payload.stats.total === 3, JSON.stringify(payload.stats));

const res3 = fakeRes();
await stateRoute.handler(fakeReq('/artifact-center/api/state?ext=PDF'), res3);
payload = JSON.parse(res3.out.body);
check('state 路由 ext 过滤去点且大小写无关', payload.items.length === 1 && payload.items[0].ext === 'pdf');

const removeRoute = routes.get('exact:/artifact-center/api/remove');
const res4 = fakeRes();
await removeRoute.handler(fakeReq('/artifact-center/api/remove', 'GET'), res4);
check('remove 路由拒绝 GET', res4.out.status === 405, String(res4.out.status));

const res5 = fakeRes();
await removeRoute.handler(fakeReq('/artifact-center/api/remove', 'POST', { id: saved[1].item.id }), res5);
payload = JSON.parse(res5.out.body);
check('remove 路由删除成功', res5.out.status === 200 && payload.ok === true, res5.out.body);
check('remove 后副本已删', await fs.access(saved[1].item.storedPath).then(() => false, () => true));

const res6 = fakeRes();
await removeRoute.handler(fakeReq('/artifact-center/api/remove', 'POST', { id: 'nope' }), res6);
payload = JSON.parse(res6.out.body);
check('remove 未知 id 返回 ok:false', payload.ok === false && /no such artifact/.test(payload.message), res6.out.body);

const revealRoute = routes.get('exact:/artifact-center/api/reveal');
const res7 = fakeRes();
await revealRoute.handler(fakeReq('/artifact-center/api/reveal', 'POST', { id: 'nope' }), res7);
check('reveal 未知 id 不执行任何进程且 404', res7.out.status === 404, String(res7.out.status));

// ── 2. 客户端半边 ──────────────────────────────────────────────────────────
console.log('宿主: 路由同源栅栏');
{
  const resPost = fakeRes();
  await stateRoute.handler(fakeReq('/artifact-center/api/state', 'POST'), resPost);
  check('state 拒绝 POST', resPost.out.status === 405, `${resPost.out.status} ${resPost.out.body}`);

  const resType = fakeRes();
  await removeRoute.handler(fakeReq('/artifact-center/api/remove', 'POST', { id: 'x' }, { 'content-type': '' }), resType);
  check('写操作拒绝非 JSON content-type（挡跨站简单请求）', resType.out.status === 415, `${resType.out.status} ${resType.out.body}`);

  const resEvil = fakeRes();
  await removeRoute.handler(fakeReq('/artifact-center/api/remove', 'POST', { id: 'x' }, { origin: 'https://evil.example' }), resEvil);
  check('拒绝跨站 Origin', resEvil.out.status === 403, `${resEvil.out.status} ${resEvil.out.body}`);

  const resLocal = fakeRes();
  await stateRoute.handler(fakeReq('/artifact-center/api/state', 'GET', undefined, { origin: 'http://127.0.0.1:19387' }), resLocal);
  check('放行本机同源 Origin（面板的正常请求）', resLocal.out.status === 200, `${resLocal.out.status}`);

  const resNoOrigin = fakeRes();
  await removeRoute.handler(fakeReq('/artifact-center/api/reveal', 'GET', undefined, { origin: 'http://localhost:19387' }), resNoOrigin);
  check('同源但方法不对仍 405', resNoOrigin.out.status === 405, `${resNoOrigin.out.status}`);
}

console.log('宿主: 注册隔离（一处失败不连累其它）');
{
  const isoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-center-iso-'));
  const isoTools = new Map();
  const isoRoutes = new Map();
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...rest) => warns.push(rest.join(' '));
  try {
    mod.apply(
      {
        tools: {
          register: (tool) => {
            if (tool.name === 'artifact_stats') throw new Error('schema.type must be one of object/array/…');
            isoTools.set(tool.name, tool);
          },
        },
        effect: (fn) => fn(),
        inject: (deps, cb) => {
          if (deps.includes('webServer')) {
            cb({
              effect: (fn) => fn(),
              webServer: {
                register: (route) => {
                  isoRoutes.set(route.path, route);
                  return () => {};
                },
              },
            });
          }
        },
      },
      { rootDir: isoRoot },
    );
  } finally {
    console.warn = realWarn;
  }
  check('stats 注册抛错后其余 3 个工具照常注册', isoTools.size === 3 && !isoTools.has('artifact_stats'), [...isoTools.keys()].join(','));
  check('stats 注册抛错后 3 条数据路由照常注册', isoRoutes.size === 3, [...isoRoutes.keys()].join(' | '));
  check('失败被记成 warning 而不是静默', warns.some((w) => /artifact_stats/.test(w)), warns.join(' / ') || 'no warning');
  // apply() 里的 store.ensure() 是异步落盘的，清理前先让那些写操作落定（否则 Windows 上会 ENOTEMPTY）
  await new Promise((r) => setTimeout(r, 150));
  await fs.rm(isoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

console.log('客户端: 模块装载与插槽注册');

let hookIndex = 0;
let stateOverride = null;
const ReactStub = {
  createElement(type, props, ...children) {
    return {
      type,
      props: props || {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
    };
  },
  useState(init) {
    hookIndex += 1;
    if (hookIndex === 5 && stateOverride) return [stateOverride, () => {}];
    return [typeof init === 'function' ? init() : init, () => {}];
  },
  useEffect() {},
  useRef(value) {
    return { current: value ?? null };
  },
  useCallback(fn) {
    return fn;
  },
};

let registration = null;
globalThis.window = {
  __ModuleLoader__: {
    load(reg) {
      registration = reg;
    },
  },
};
await import(pathToFileURL(path.join(pkgDir, 'client.js')).href);
check('client.js 注册到 __ModuleLoader__', registration !== null && registration.id === 'artifact-center');

const requireStub = (specifier) => {
  if (specifier === 'react') return ReactStub;
  throw new Error(`unexpected require("${specifier}")`);
};
const clientExports = registration.factory(requireStub);
check('client 导出 apply', typeof clientExports.apply === 'function');
check('client 导出 inject', Array.isArray(clientExports.inject), JSON.stringify(clientExports.inject));
check('client inject 含 slots', clientExports.inject.includes('slots'));

const registrations = [];
const clientCtx = {
  effect: (fn) => fn(),
  locale: { register: () => () => {}, bind: () => (key) => key },
  slots: {
    inject: (_owner, cb) => cb(),
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  },
};
clientExports.apply(clientCtx);
check('注册了 2 个插槽（main + sidebar.panellist）', registrations.length === 2, String(registrations.length));
const mainReg = registrations.find((r) => r.options.name === 'main');
const panelReg = registrations.find((r) => r.options.name === 'sidebar.panellist');
check('main 用 key=PANEL_ID', mainReg && mainReg.options.key === 'artifacts', JSON.stringify(mainReg && mainReg.options));
check('panellist 用 id=PANEL_ID 且有 order/label',
  panelReg && panelReg.options.id === 'artifacts' && panelReg.options.order === 30 && panelReg.options.label() === 'panel',
  JSON.stringify(panelReg && panelReg.options));

const icon = panelReg.component({ size: 16 });
check('图标直接渲染 svg（无包装元素）', icon && icon.type === 'svg' && icon.props.width === 16);
check('图标含 3 个子节点', icon.children.length === 3, String(icon.children.length));

/** 把元素树压平成可搜索的字符串，便于断言渲染结果。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (typeof node === 'object' && node.type) {
    const cls = node.props && node.props.className;
    out.push(`<${typeof node.type === 'string' ? node.type : 'C'}${cls ? `.${cls}` : ''}>`);
    flatten(node.children, out);
  }
  return out;
}

const Page = mainReg.component;
hookIndex = 0;
stateOverride = null;
let tree;
try {
  tree = Page({ t: undefined });
  check('面板空态渲染不抛异常', true);
} catch (e) {
  check('面板空态渲染不抛异常', false, e.stack);
}
let flat = flatten(tree).join(' ');
check('空态显示「还没有登记任何产物」', flat.includes('还没有登记任何产物'), flat.slice(0, 200));
check('空态包含 hint', flat.includes('artifact_save'));
check('页头含标题「产物中心」', flat.includes('产物中心'));

// 有数据时（第 5 个 useState = state）
hookIndex = 0;
stateOverride = {
  phase: 'ready',
  error: '',
  data: {
    ok: true,
    rootDir: 'C:\\Users\\x\\.dsh\\artifact-center',
    categories: ['pdf', 'excel', 'ppt', 'word', 'image', 'code', 'data', 'archive', 'other'],
    stats: { total: 3, byCategory: { pdf: 1, excel: 1, code: 1 }, byExt: { pdf: 1, xlsx: 2, py: 1 } },
    items: [
      { id: 'a1', title: '报告', ext: 'pdf', category: 'pdf', size: 2048, mode: 'copy', note: '季度报告', tags: ['季度'], createdAt: '2024-05-01T00:00:00.000Z', storedPath: 'C:\\root\\files\\报告.pdf' },
      { id: 'a2', title: '数据', ext: 'xlsx', category: 'excel', size: 4096, mode: 'link', note: '', tags: [], createdAt: '2024-05-02T00:00:00.000Z', storedPath: 'C:\\src\\数据.xlsx' },
      { id: 'a3', title: '脚本', ext: 'py', category: 'code', size: 1024, mode: 'copy', note: '', tags: [], createdAt: '2024-05-03T00:00:00.000Z', storedPath: 'C:\\root\\files\\脚本.py' },
    ],
  },
};
tree = Page({ t: undefined });
flat = flatten(tree).join(' ');
check('有数据时渲染 3 行', (flat.match(/<div\.ac-row>/g) || []).length === 3, String((flat.match(/<div\.ac-row>/g) || []).length));
check('行内显示扩展名与备注', flat.includes('.pdf') && flat.includes('季度报告'));
check('行内显示分类中文名', flat.includes('PDF') && flat.includes('代码'));
check('行内显示 link 模式标签', flat.includes('链接'));
check('行内显示大小', flat.includes('2.0 KB'), flat.slice(0, 300));
check('筛选栏含全部/分类/后缀 chip', flat.includes('全部') && flat.includes('xlsx') && flat.includes('py'));
check('页头显示总数与根目录', flat.includes('共 3 个') && flat.includes('artifact-center'));
check('操作按钮齐全', flat.includes('定位文件') && flat.includes('复制路径') && flat.includes('删除'));
check('空态不再出现', !flat.includes('还没有登记任何产物'));

hookIndex = 0;
stateOverride = { phase: 'ready', error: '', data: { ok: true, rootDir: 'C:\\x', categories: ['pdf'], stats: { total: 3, byCategory: { pdf: 3 }, byExt: { pdf: 3 } }, items: [] } };
flat = flatten(Page({ t: undefined })).join(' ');
check('有数据但筛选无命中时提示「当前筛选没有匹配项」', flat.includes('当前筛选没有匹配项'), flat.slice(0, 200));

hookIndex = 0;
stateOverride = { phase: 'error', error: 'ECONNREFUSED', data: null };
flat = flatten(Page({ t: undefined })).join(' ');
check('fetch 失败时显示错误条', flat.includes('无法读取产物索引') && flat.includes('ECONNREFUSED'), flat.slice(0, 200));

// ── 收尾 ───────────────────────────────────────────────────────────────────
await fs.rm(root, { recursive: true, force: true }).catch(() => {});
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
