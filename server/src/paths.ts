import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

export const ROOT_DIR = path.resolve(__dirname, '..', '..');

// 必须在读取任何 process.env 之前加载 .env
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT_DIR, 'data');

export const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(DATA_DIR, 'gateway.db');

export const WEB_DIST_DIR = path.join(ROOT_DIR, 'web', 'dist');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
