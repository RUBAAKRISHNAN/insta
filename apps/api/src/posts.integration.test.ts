import '../scripts/integration-test-safety.mjs';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { env } from './config/env.js';
import { closeDatabase, getDb } from './db/client.js';
import { posts, users } from './db/schema/index.js';
import { imageStorage } from './storage/image-storage.js';

type TestAgent = ReturnType<typeof request.agent>;

const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const email = `posts.${suffix}@example.test`;
const username = `post_${suffix}`;
const password = 'Post-integration-password-123!';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=',
  'base64',
);
let database: NonNullable<ReturnType<typeof getDb>> | undefined;
let owner: TestAgent;
let ownerId: string;
const storedKeys: string[] = [];

function getDatabase() {
  if (!database) throw new Error('Post integration tests require DATABASE_URL and applied migrations.');
  return database;
}

async function issueCsrf(agent: TestAgent) {
  const response = await agent.get('/api/csrf');
  expect(response.status).toBe(200);
  return response.body.data.csrfToken as string;
}

async function submitPost(
  agent: TestAgent,
  caption: string,
  image = png,
  filename = 'upload.png',
  contentType = 'image/png',
) {
  const csrf = await issueCsrf(agent);
  return agent
    .post('/api/posts')
    .set('Origin', env.WEB_ORIGIN)
    .set('x-csrf-token', csrf)
    .field('caption', caption)
    .attach('image', image, { filename, contentType });
}

describe('database-backed post creation and image access', () => {
  beforeAll(async () => {
    const activeDatabase = getDb();
    if (!activeDatabase) throw new Error('Post integration tests require DATABASE_URL.');
    database = activeDatabase;
    await activeDatabase.execute(sql`select 1`);
    await activeDatabase.select({ id: posts.id }).from(posts).limit(1);

    owner = request.agent(app);
    const csrf = await issueCsrf(owner);
    const registration = await owner
      .post('/api/auth/register')
      .set('Origin', env.WEB_ORIGIN)
      .set('x-csrf-token', csrf)
      .send({
        username,
        email,
        password,
        displayName: 'Post Integration User',
      });
    expect(registration.status).toBe(201);
    ownerId = registration.body.data.user.id as string;
  });

  afterAll(async () => {
    for (const key of storedKeys) await imageStorage.remove(key);
    if (database) await database.delete(users).where(eq(users.email, email));
    await closeDatabase();
  });

  it('requires an authenticated session before accepting an upload', async () => {
    const guest = request.agent(app);
    const csrf = await issueCsrf(guest);
    const response = await guest
      .post('/api/posts')
      .set('Origin', env.WEB_ORIGIN)
      .set('x-csrf-token', csrf)
      .field('caption', 'Guest post')
      .attach('image', png, 'guest.png');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects file content that is not an allowed image even when its filename and MIME claim otherwise', async () => {
    const response = await submitPost(
      owner,
      'Not really an image',
      Buffer.from('not an image'),
      'photo.png',
      'image/png',
    );

    expect(response.status).toBe(415);
    expect(response.body.error.code).toBe('INVALID_UPLOAD');
  });

  it('rejects uploads larger than the server limit', async () => {
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0);
    const response = await submitPost(owner, 'Too large', oversized);

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('UPLOAD_TOO_LARGE');
  });

  it('rejects captions beyond the database and API limit', async () => {
    const response = await submitPost(owner, 'x'.repeat(2201));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('stores post metadata and serves the private image only to its owner', async () => {
    const response = await submitPost(owner, '  Hello from integration  ');

    expect(response.status).toBe(201);
    expect(response.body.data.post).toMatchObject({
      caption: 'Hello from integration',
      imageUrl: expect.stringMatching(/^\/posts\/[0-9a-f-]+\/image$/),
    });
    const postId = response.body.data.post.id as string;
    const persisted = await getDatabase()
      .select({
        userId: posts.userId,
        caption: posts.caption,
        imageKey: posts.imageKey,
        imageContentType: posts.imageContentType,
      })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      userId: ownerId,
      caption: 'Hello from integration',
      imageContentType: 'image/png',
    });
    expect(persisted[0].imageKey).toMatch(/^[0-9a-f-]+\.png$/);
    storedKeys.push(persisted[0].imageKey);

    await getDatabase().update(users).set({ isPrivate: true }).where(eq(users.id, ownerId));
    const ownerImage = await owner.get(`/api${response.body.data.post.imageUrl}`);
    expect(ownerImage.status).toBe(200);
    expect(ownerImage.headers['content-type']).toContain('image/png');
    expect(ownerImage.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(ownerImage.body)).toEqual(png);

    const guestImage = await request(app).get(`/api${response.body.data.post.imageUrl}`);
    expect(guestImage.status).toBe(404);
    expect(guestImage.body.error.code).toBe('NOT_FOUND');
  });
});
