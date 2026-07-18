import fs from 'node:fs/promises';
import path from 'node:path';

const NAMESPACE = 'icant-master-v1/';
const LOCAL_ROOT = path.resolve(process.cwd(), '.local-data');

function cleanKey(key = '') {
  return String(key).replace(/^\/+/, '').replace(/\\/g, '/').replace(/\.\.(\/|$)/g, '');
}
function fullKey(key = '') { return `${NAMESPACE}${cleanKey(key)}`; }
function localPath(key = '') { return path.join(LOCAL_ROOT, ...cleanKey(key).split('/')); }
function onVercel() { return Boolean(process.env.VERCEL); }
function hasBlob() { return Boolean(process.env.BLOB_READ_WRITE_TOKEN); }
function storageError() {
  const error = new Error('Banco ainda não conectado. No Vercel, abra Storage → Create Database → Blob, crie um armazenamento PRIVADO e conecte ao projeto. Depois faça Redeploy.');
  error.code = 'VERCEL_BLOB_NOT_CONFIGURED';
  error.status = 503;
  return error;
}
async function sdk() {
  if (!hasBlob()) throw storageError();
  return import('@vercel/blob');
}
async function streamToBuffer(stream) {
  if (!stream) return null;
  return Buffer.from(await new Response(stream).arrayBuffer());
}
async function localWalk(dir, base = '') {
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await localWalk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

function localStore() {
  return {
    async get(key, options = {}) {
      try {
        const data = await fs.readFile(localPath(key));
        if (options.type === 'json') return JSON.parse(data.toString('utf8'));
        if (options.type === 'arrayBuffer') return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        if (options.type === 'text') return data.toString('utf8');
        return data;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async setJSON(key, value, options = {}) {
      const file = localPath(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      if (options.onlyIfNew) {
        try { await fs.access(file); return { key }; } catch { /* new */ }
      }
      await fs.writeFile(file, JSON.stringify(value));
      return { key };
    },
    async set(key, value) {
      const file = localPath(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const body = value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value);
      await fs.writeFile(file, body);
      return { key };
    },
    async delete(key) {
      await fs.rm(localPath(key), { force: true });
    },
    async list({ prefix = '' } = {}) {
      const files = await localWalk(LOCAL_ROOT);
      const p = cleanKey(prefix);
      return { blobs: files.filter(k => k.startsWith(p)).map(key => ({ key })), hasMore: false };
    }
  };
}

function blobStore() {
  return {
    async get(key, options = {}) {
      const { get } = await sdk();
      const result = await get(fullKey(key), { access: 'private' });
      if (!result || result.statusCode !== 200) return null;
      const data = await streamToBuffer(result.stream);
      if (options.type === 'json') {
        try { return JSON.parse(data.toString('utf8')); } catch { return null; }
      }
      if (options.type === 'arrayBuffer') return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      if (options.type === 'text') return data.toString('utf8');
      return data;
    },
    async setJSON(key, value, options = {}) {
      const { put, get } = await sdk();
      const pathname = fullKey(key);
      if (options.onlyIfNew) {
        const existing = await get(pathname, { access: 'private' }).catch(() => null);
        if (existing) return existing.blob;
      }
      try {
        return await put(pathname, JSON.stringify(value), {
          access: 'private',
          allowOverwrite: !options.onlyIfNew,
          contentType: 'application/json; charset=utf-8',
          cacheControlMaxAge: 60
        });
      } catch (error) {
        if (options.onlyIfNew && /exist|overwrite|already/i.test(String(error?.message))) return { pathname };
        throw error;
      }
    },
    async set(key, value, options = {}) {
      const { put } = await sdk();
      return put(fullKey(key), value instanceof ArrayBuffer ? value : Buffer.from(value), {
        access: 'private',
        allowOverwrite: true,
        contentType: options.metadata?.mime || 'application/octet-stream',
        cacheControlMaxAge: 60
      });
    },
    async delete(key) {
      const { del } = await sdk();
      await del(fullKey(key));
    },
    async list({ prefix = '' } = {}) {
      const { list } = await sdk();
      const all = [];
      let cursor;
      do {
        const result = await list({ prefix: fullKey(prefix), limit: 1000, cursor });
        all.push(...result.blobs.map(blob => ({ ...blob, key: blob.pathname.slice(NAMESPACE.length) })));
        cursor = result.hasMore ? result.cursor : undefined;
      } while (cursor);
      return { blobs: all, hasMore: false };
    }
  };
}

export function createStore() {
  if (onVercel()) return blobStore();
  return localStore();
}

export function storageConfigured() {
  return !onVercel() || hasBlob();
}
