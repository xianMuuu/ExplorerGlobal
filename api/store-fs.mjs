// 本机文件存储适配器：键值数据存成 <目录>/kv/<键>.json，二进制数据存成 <目录>/blobs/<键>.bin。
// 键用 / 分层（例如 user/张三、chunk/<模型编号>/3），每一层转义后作为文件名，不会跑出数据目录。
import fs from 'node:fs/promises';
import path from 'node:path';

const seg = (s) => encodeURIComponent(s).replace(/[!'()*~.]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function fsStore(dir) {
  const kvRoot = path.join(dir, 'kv');
  const blobRoot = path.join(dir, 'blobs');
  const file = (root, key, ext) => path.join(root, ...key.split('/').filter(Boolean).map(seg)) + ext;

  async function write(p, data) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await fs.writeFile(tmp, data);
    try {
      await fs.rename(tmp, p);
    } catch (e) {
      // Windows 上目标文件被杀毒软件短暂占用时会失败，稍等再试一次
      await new Promise((r) => setTimeout(r, 120));
      await fs.rename(tmp, p);
    }
  }
  async function read(p, encoding) {
    try {
      return await fs.readFile(p, encoding);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
  async function remove(p) {
    try {
      await fs.unlink(p);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  // 列出一个前缀下的键。前缀必须以 / 结尾（即列出一层目录）。
  async function names(root, prefix, ext) {
    const dirPath = path.join(root, ...prefix.split('/').filter(Boolean).map(seg));
    try {
      const list = await fs.readdir(dirPath);
      return list.filter((n) => n.endsWith(ext)).map((n) => prefix + decodeURIComponent(n.slice(0, -ext.length)));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  return {
    async getJSON(key) {
      const text = await read(file(kvRoot, key, '.json'), 'utf8');
      return text === null ? null : JSON.parse(text);
    },
    putJSON(key, value) {
      return write(file(kvRoot, key, '.json'), JSON.stringify(value));
    },
    del(key) {
      return remove(file(kvRoot, key, '.json'));
    },
    list(prefix) {
      return names(kvRoot, prefix, '.json');
    },
    getBlob(key) {
      return read(file(blobRoot, key, '.bin'));
    },
    putBlob(key, data) {
      return write(file(blobRoot, key, '.bin'), data);
    },
    async delBlob(key) {
      const p = file(blobRoot, key, '.bin');
      await remove(p);
      try {
        await fs.rmdir(path.dirname(p)); // 目录空了就顺手删掉，不空会失败，忽略即可
      } catch (e) { /* 目录非空或已不存在 */ }
    },
    listBlobs(prefix) {
      return names(blobRoot, prefix, '.bin');
    },
  };
}
