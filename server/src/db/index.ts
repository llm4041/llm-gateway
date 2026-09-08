import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../paths';

/**
 * 使用 Node 22 内置的 node:sqlite（同步 API），避免原生模块编译。
 * 注意：绑定参数只支持 null / number / bigint / string / Uint8Array，
 * 因此所有布尔值在入库前都要转成 0/1，undefined 要转成 null。
 */
export const sqlite = new DatabaseSync(DB_PATH);

sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA synchronous = NORMAL');
sqlite.exec('PRAGMA foreign_keys = ON');
sqlite.exec('PRAGMA busy_timeout = 5000');

type Bind = null | number | bigint | string | Uint8Array;

function normalize(params: unknown[]): Bind[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'number' || typeof p === 'string' || typeof p === 'bigint' || p instanceof Uint8Array) return p;
    return String(p);
  });
}

export function all<T = any>(sql: string, ...params: unknown[]): T[] {
  return sqlite.prepare(sql).all(...normalize(params)) as T[];
}

export function get<T = any>(sql: string, ...params: unknown[]): T | undefined {
  return sqlite.prepare(sql).get(...normalize(params)) as T | undefined;
}

export function run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
  const r = sqlite.prepare(sql).run(...normalize(params));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

export function exec(sql: string): void {
  sqlite.exec(sql);
}
