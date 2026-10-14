import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { defineTool } from './lib/defineTool.js';
import { ArtifactStore, CATEGORIES } from './lib/store.js';

export const name = 'artifact-center';
export const inject = ['tools'];

const DEFAULT_ROOT = path.join(os.homedir(), '.dsh', 'artifact-center');
const API_PREFIX = '/artifact-center/api/';

function renderText(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/**
 * 单个注册失败不能连累其它注册。
 * 教训：工具 schema 一旦不被宿主接受，register() 是同步抛错的；没有这层隔离时
 * apply() 会当场中断，后面的 webserver 路由根本没机会注册 —— 表现就是侧边栏面板
 * 全渲染正常却报「无法读取产物索引: HTTP 404」。现在坏一个只损失一个。
 */
function safe(label, fn) {
  try {
    return fn();
  } catch (e) {
    console.warn(`[artifact-center] ${label} 注册失败：${e?.message ?? e}`);
    return undefined;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 本机路由的同源栅栏。
 * 这条路由落在 127.0.0.1 上，任何本机进程本来就读得到 ~/.dsh/artifact-center/index.json，
 * 所以真正的威胁是「浏览器里的第三方页面借用户身份打过来」（DNS rebinding / CSRF）：
 *  · 带 Origin 的跨站请求直接 403；
 *  · 写操作必须 application/json —— 跨站表单/text-plain 这类「简单请求」不触发预检，
 *    声明 JSON 则会预检，而预检打到本路由必然 405/415，于是被挡住；
 *  · 非浏览器调用（curl / node，没有 Origin）照常可用。
 * 不引入 connection 服务的鉴权：面板是同源 fetch，加上它只会在拿不到 cookie 时把面板打回 401。
 */
function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (origin === undefined || origin === '') return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function guard(req, res, { method, json }) {
  if (!sameOrigin(req)) {
    sendJson(res, 403, { ok: false, message: 'cross-origin request rejected' });
    return false;
  }
  if (req.method !== method) {
    sendJson(res, 405, { ok: false, message: `${method} required` });
    return false;
  }
  if (json) {
    const type = String(req.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    if (type !== 'application/json') {
      sendJson(res, 415, { ok: false, message: 'content-type: application/json required' });
      return false;
    }
  }
  return true;
}

/** 在文件管理器中定位产物（只按索引里的 id 解析路径，不接受任意路径） */
function revealInFolder(target) {
  if (process.platform === 'win32') {
    const child = spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [path.dirname(target)], { detached: true, stdio: 'ignore' });
  child.unref();
}

export function apply(ctx, config = {}) {
  const rootDir = config.rootDir || DEFAULT_ROOT;
  const store = new ArtifactStore(rootDir);
  const ready = store.ensure();

  const wrap = (fn) => async (args, exec) => {
    await ready;
    try {
      return await fn(args, exec);
    } catch (e) {
      return { ok: false, message: e.message }; // 普通失败不抛，返回结构化值
    }
  };

  // 1. 收录产物 —— agent 产出重要文件后必须调用
  safe('artifact_save', () => ctx.tools.register(defineTool({
    name: 'artifact_save',
    description:
      'Save an important output file to the cross-session Artifact Center (产物中心). ' +
      'Call this EVERY time you produce a deliverable file the user will want later: ' +
      'PDF, Excel, PowerPoint, Word, images, scripts (.py), data (.json/.csv), reports, etc. ' +
      'By default the file is copied so it survives session cleanup; pass mode:"link" to only record the path. ' +
      'Returns the artifact id and its stored location.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of the file to save' },
      title: { type: 'string', description: 'Human-readable title (defaults to file name)' },
      note: { type: 'string', description: 'What this artifact is / how to use it' },
      tags: { type: 'array', description: 'Optional tags for filtering', items: { type: 'string' } },
      mode: { type: 'string', description: '"copy" (default, duplicate file) or "link" (record path only)' },
    },
    output: { schema: { type: 'json' }, render: renderText },
    execute: wrap((args, exec) =>
      store.add(
        {
          path: args.path,
          title: args.title,
          note: args.note,
          tags: args.tags,
          mode: args.mode === 'link' ? 'link' : 'copy',
          session: exec?.agent?.sessionId || '',
        },
        exec?.signal,
      )),
  })));

  // 2. 列表/筛选
  safe('artifact_list', () => ctx.tools.register(defineTool({
    name: 'artifact_list',
    description:
      'List files in the cross-session Artifact Center (产物中心), with optional filters. ' +
      'Use to find previously produced deliverables by extension (pdf/xlsx/pptx/py/json/...), ' +
      'by category (pdf/excel/ppt/word/image/code/data/archive), or by keyword.',
    parameters: {
      ext: { type: 'string', description: 'Filter by file extension, e.g. "pdf", "xlsx", "py"' },
      category: { type: 'string', description: 'Filter by category: pdf/excel/ppt/word/image/code/data/archive/other' },
      keyword: { type: 'string', description: 'Keyword matched against title, file name, path, note, tags' },
    },
    output: { schema: { type: 'json' }, render: renderText },
    execute: wrap((args) => store.list({ ext: args.ext, category: args.category, keyword: args.keyword })),
  })));

  // 3. 统计
  safe('artifact_stats', () => ctx.tools.register(defineTool({
    name: 'artifact_stats',
    description: 'Show counts of artifacts in the Artifact Center (产物中心), grouped by category and extension.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderText },
    execute: wrap(() => store.stats()),
  })));

  // 4. 删除
  safe('artifact_remove', () => ctx.tools.register(defineTool({
    name: 'artifact_remove',
    description:
      'Remove one artifact entry from the Artifact Center by id. For "copy" artifacts the stored copy is deleted; ' +
      'for "link" artifacts only the entry is removed, the original file is never touched.',
    parameters: {
      id: { type: 'string', required: true, description: 'Artifact id returned by artifact_save / artifact_list' },
    },
    output: { schema: { type: 'json' }, render: renderText },
    execute: wrap((args) => store.remove(args.id)),
  })));

  // 5. 侧边栏面板的数据通道：宿主 webserver 路由（Web GUI 与页面同源，客户端 fetch 直取）。
  //    无 webServer 的形态（纯 CLI / 桌面 IPC）下这段不激活，工具照常可用。
  safe('webserver routes', () => ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: `${API_PREFIX}state`,
        handler: async (req, res) => {
          try {
            if (!guard(req, res, { method: 'GET' })) return;
            await ready;
            const url = new URL(req.url ?? '/', 'http://localhost');
            const items = await store.list({
              ext: url.searchParams.get('ext') || undefined,
              category: url.searchParams.get('category') || undefined,
              keyword: url.searchParams.get('keyword') || undefined,
            });
            const stats = await store.stats();
            sendJson(res, 200, { ok: true, items, stats, rootDir, categories: CATEGORIES });
          } catch (e) {
            sendJson(res, 500, { ok: false, message: e.message });
          }
        },
      }),
      'artifact-center: state route',
    );

    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: `${API_PREFIX}remove`,
        handler: async (req, res) => {
          try {
            if (!guard(req, res, { method: 'POST', json: true })) return;
            await ready;
            const { id } = await readJsonBody(req);
            sendJson(res, 200, await store.remove(String(id ?? '')));
          } catch (e) {
            sendJson(res, 500, { ok: false, message: e.message });
          }
        },
      }),
      'artifact-center: remove route',
    );

    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: `${API_PREFIX}reveal`,
        handler: async (req, res) => {
          try {
            if (!guard(req, res, { method: 'POST', json: true })) return;
            await ready;
            const { id } = await readJsonBody(req);
            // 只认索引里的 id，路径由服务端解析，客户端无法借它打开任意路径
            const [item] = await store.list().then((all) => all.filter((it) => it.id === id));
            if (!item) {
              sendJson(res, 404, { ok: false, message: `no such artifact: ${id}` });
              return;
            }
            revealInFolder(item.storedPath);
            sendJson(res, 200, { ok: true });
          } catch (e) {
            sendJson(res, 500, { ok: false, message: e.message });
          }
        },
      }),
      'artifact-center: reveal route',
    );
  }));

  return { rootDir };
}
