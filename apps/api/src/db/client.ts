import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';
let pool: Pool | undefined;
export function getPool(): Pool | undefined { if (!env.DATABASE_URL) return undefined; if (!pool) { pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 }); pool.on('error', (error) => console.error(JSON.stringify({ level: 'error', event: 'db_pool_error', message: error.message }))); } return pool; }
export function getDb() { const activePool = getPool(); return activePool ? drizzle(activePool, { schema }) : undefined; }
export async function checkDatabase(): Promise<boolean> { const activePool = getPool(); if (!activePool) return false; try { await activePool.query('select 1'); return true; } catch { return false; } }
export async function closeDatabase(): Promise<void> { if (pool) await pool.end(); }
