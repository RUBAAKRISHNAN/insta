import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { getDb } from '../db/client.js';
import { storedImages } from '../db/schema/index.js';

export interface ImageStorage {
  put(key: string, contents: Buffer): Promise<void>;
  read(key: string): Promise<Buffer | undefined>;
  remove(key: string): Promise<void>;
}

const keyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/;

function filePath(directory: string, key: string) {
  if (!keyPattern.test(key)) {
    throw new Error('Invalid image storage key.');
  }
  const path = resolve(directory, key);
  if (!path.startsWith(`${directory}${sep}`)) {
    throw new Error('Invalid image storage path.');
  }
  return path;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

class LocalImageStorage implements ImageStorage {
  private readonly directory = resolve(
    env.IMAGE_UPLOAD_DIR ?? resolve(process.cwd(), 'var', 'uploads'),
  );

  async put(key: string, contents: Buffer): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(filePath(this.directory, key), contents, { flag: 'wx', mode: 0o600 });
  }

  async read(key: string): Promise<Buffer | undefined> {
    try {
      return await readFile(filePath(this.directory, key));
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await unlink(filePath(this.directory, key));
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
  }
}

/** Keeps image bytes in PostgreSQL so they survive redeploys on hosts without durable disks. */
class DatabaseImageStorage implements ImageStorage {
  private database() {
    const db = getDb();
    if (!db) throw new Error('Database unavailable.');
    return db;
  }

  async put(key: string, contents: Buffer): Promise<void> {
    if (!keyPattern.test(key)) throw new Error('Invalid image storage key.');
    await this.database()
      .insert(storedImages)
      .values({ key, contents, byteSize: contents.byteLength });
  }

  async read(key: string): Promise<Buffer | undefined> {
    if (!keyPattern.test(key)) throw new Error('Invalid image storage key.');
    const [row] = await this.database()
      .select({ contents: storedImages.contents })
      .from(storedImages)
      .where(eq(storedImages.key, key))
      .limit(1);
    return row?.contents;
  }

  async remove(key: string): Promise<void> {
    if (!keyPattern.test(key)) throw new Error('Invalid image storage key.');
    await this.database().delete(storedImages).where(eq(storedImages.key, key));
  }
}

export const imageStorage: ImageStorage = (() => {
  switch (env.IMAGE_STORAGE) {
    case 'local':
      return new LocalImageStorage();
    case 'database':
      return new DatabaseImageStorage();
  }
})();
