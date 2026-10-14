import { promises as fs } from 'node:fs';
import path from 'node:path';

const INDEX_FILE = 'index.json';
const FILES_DIR = 'files';

function extOf(name) {
  const e = path.extname(name).toLowerCase();
  return e.startsWith('.') ? e.slice(1) : '';
}

// 与前端筛选分类对齐：按后缀归入大类
const CATEGORY_RULES = [
  ['pdf', ['pdf']],
  ['excel', ['xlsx', 'xls', 'csv']],
  ['ppt', ['pptx', 'ppt']],
  ['word', ['docx', 'doc']],
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']],
  ['code', ['py', 'js', 'ts', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'm']],
  ['data', ['json', 'yaml', 'yml', 'xml', 'toml', 'ini', 'txt', 'md']],
  ['archive', ['zip', 'rar', '7z', 'tar', 'gz']],
];

/** 分类的稳定顺序（面板块与宿主 API 共用，避免两处各写一份） */
export const CATEGORIES = CATEGORY_RULES.map(([cat]) => cat).concat('other');

function categoryOf(ext) {
  for (const [cat, exts] of CATEGORY_RULES) {
    if (exts.includes(ext)) return cat;
  }
  return 'other';
}

export class ArtifactStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.indexPath = path.join(rootDir, INDEX_FILE);
    this.filesDir = path.join(rootDir, FILES_DIR);
    this._queue = Promise.resolve(); // 串行写索引，避免并发覆盖
  }

  async ensure() {
    await fs.mkdir(this.filesDir, { recursive: true });
    try {
      await fs.access(this.indexPath);
    } catch {
      await fs.writeFile(this.indexPath, JSON.stringify({ version: 1, items: [] }, null, 2), 'utf8');
    }
  }

  _enqueue(fn) {
    const next = this._queue.then(fn, fn);
    this._queue = next.catch(() => {});
    return next;
  }

  async _readIndex() {
    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data.items) ? data.items : [];
    } catch {
      return [];
    }
  }

  async _writeIndex(items) {
    await fs.writeFile(this.indexPath, JSON.stringify({ version: 1, items }, null, 2), 'utf8');
  }

  /**
   * 登记一个产物。mode: 'copy'（默认，复制到产物中心）| 'link'（只登记原始路径）
   * 返回 { ok, item } 或 { ok: false, message }
   */
  async add({ path: srcPath, title, note, tags, mode = 'copy', session }, signal) {
    if (!srcPath) return { ok: false, message: 'path is required' };
    const abs = path.resolve(srcPath);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch (e) {
      return { ok: false, message: `cannot stat file: ${abs} (${e.message})` };
    }
    if (!stat.isFile()) return { ok: false, message: `not a regular file: ${abs}` };

    const now = new Date().toISOString();
    const base = path.basename(abs);
    const ext = extOf(base);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    let storedPath = abs;
    if (mode === 'copy') {
      // 文件名冲突时加 id 前缀
      const target = path.join(this.filesDir, base);
      try {
        await fs.access(target);
        storedPath = path.join(this.filesDir, `${id}-${base}`);
      } catch {
        storedPath = target;
      }
      await fs.copyFile(abs, storedPath);
    }

    const item = {
      id,
      title: title || base,
      originalName: base,
      originalPath: abs,
      storedPath,
      mode,
      ext,
      category: categoryOf(ext),
      size: stat.size,
      note: note || '',
      tags: Array.isArray(tags) ? tags : [],
      session: session || '',
      createdAt: now,
    };

    await this._enqueue(async () => {
      const items = await this._readIndex();
      items.unshift(item); // 最新在前
      await this._writeIndex(items);
    });

    return { ok: true, item };
  }

  /** 列表/筛选。filter: { ext, category, keyword } 均可选 */
  async list(filter = {}) {
    const items = await this._readIndex();
    const { ext, category, keyword } = filter;
    return items.filter((it) => {
      if (ext && it.ext !== String(ext).toLowerCase().replace(/^\./, '')) return false;
      if (category && it.category !== category) return false;
      if (keyword) {
        const kw = String(keyword).toLowerCase();
        const hay = `${it.title} ${it.originalName} ${it.originalPath} ${it.note} ${(it.tags || []).join(' ')}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }

  async remove(id) {
    return this._enqueue(async () => {
      const items = await this._readIndex();
      const idx = items.findIndex((it) => it.id === id);
      if (idx < 0) return { ok: false, message: `no such artifact: ${id}` };
      const [gone] = items.splice(idx, 1);
      await this._writeIndex(items);
      // copy 模式才删副本；link 模式绝不动原文件
      if (gone.mode === 'copy') {
        await fs.rm(gone.storedPath, { force: true }).catch(() => {});
      }
      return { ok: true, item: gone };
    });
  }

  /** 各分类计数，供前端筛选栏显示 */
  async stats() {
    const items = await this._readIndex();
    const byCategory = {};
    const byExt = {};
    for (const it of items) {
      byCategory[it.category] = (byCategory[it.category] || 0) + 1;
      if (it.ext) byExt[it.ext] = (byExt[it.ext] || 0) + 1;
    }
    return { total: items.length, byCategory, byExt };
  }
}
