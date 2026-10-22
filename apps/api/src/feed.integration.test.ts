import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { env } from './config/env.js';
import { closeDatabase, getDb } from './db/client.js';
import { posts, users } from './db/schema/index.js';

type TestAgent = ReturnType<typeof request.agent>;

const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const ownerEmail = `feed.${suffix}@example.test`;
const ownerUsername = `feed_${suffix}`;
const privateEmail = `feed.private.${suffix}@example.test`;
const privateUsername = `priv_${suffix}`;
const password = 'Feed-integration-password-123!';
const publicIds = [randomUUID(), randomUUID(), randomUUID()];
let database: NonNullable<ReturnType<typeof getDb>> | undefined;
let owner: TestAgent;
let ownerId: string;
let privateAuthorId: string;

function getDatabase() {
  if (!database)
    throw new Error('Feed integration tests require DATABASE_URL and applied migrations.');
  return database;
}

async function issueCsrf(agent: TestAgent) {
  const response = await agent.get('/api/csrf');
  expect(response.status).toBe(200);
  return response.body.data.csrfToken as string;
}

async function createFixturePosts() {
  const older = new Date('2026-10-20T12:00:00.000Z');
  const newest = new Date('2026-10-21T12:00:00.000Z');
  await getDatabase()
    .insert(posts)
    .values([
      {
        id: publicIds[0],
        userId: ownerId,
        caption: 'Oldest public post',
        imageKey: `${randomUUID()}.png`,
        imageContentType: 'image/png',
        createdAt: older,
      },
      {
        id: publicIds[1],
        userId: ownerId,
        caption: 'Tied post A',
        imageKey: `${randomUUID()}.png`,
        imageContentType: 'image/png',
        createdAt: newest,
      },
      {
        id: publicIds[2],
        userId: ownerId,
        caption: 'Tied post B',
        imageKey: `${randomUUID()}.png`,
        imageContentType: 'image/png',
        createdAt: newest,
      },
    ]);
}

describe('authenticated post feed', () => {
  beforeAll(async () => {
    const activeDatabase = getDb();
    if (!activeDatabase) throw new Error('Feed integration tests require DATABASE_URL.');
    database = activeDatabase;
    await activeDatabase.execute(sql`select 1`);
    await activeDatabase.select({ id: posts.id }).from(posts).limit(1);

    owner = request.agent(app);
    const token = await issueCsrf(owner);
    const registration = await owner
      .post('/api/auth/register')
      .set('Origin', env.WEB_ORIGIN)
      .set('x-csrf-token', token)
      .send({
        username: ownerUsername,
        email: ownerEmail,
        password,
        displayName: 'Feed User',
      });
    expect(registration.status).toBe(201);
    ownerId = registration.body.data.user.id as string;

    const [privateAuthor] = await activeDatabase
      .insert(users)
      .values({
        username: privateUsername,
        email: privateEmail,
        passwordHash: 'feed-test-only',
        displayName: 'Private Feed Author',
        isPrivate: true,
      })
      .returning({ id: users.id });
    if (!privateAuthor) throw new Error('Could not create private feed fixture account.');
    privateAuthorId = privateAuthor.id;
  });

  afterAll(async () => {
    if (database) {
      await database.delete(users).where(eq(users.email, ownerEmail));
      await database.delete(users).where(eq(users.email, privateEmail));
    }
    await closeDatabase();
  });

  it('rejects unauthenticated feed requests', async () => {
    const response = await request(app).get('/api/posts');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns an empty feed before posts exist', async () => {
    const response = await owner.get('/api/posts');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ posts: [], nextCursor: null });
  });

  it('orders posts newest first and paginates deterministically across equal timestamps', async () => {
    await createFixturePosts();

    const first = await owner.get('/api/posts').query({ limit: 2 });
    expect(first.status).toBe(200);
    const expectedTiedIds = publicIds.slice(1).sort((left, right) => right.localeCompare(left));
    expect(first.body.data.posts.map((post: { id: string }) => post.id)).toEqual(expectedTiedIds);
    expect(first.body.data.posts[0]).toEqual({
      id: expectedTiedIds[0],
      caption: expectedTiedIds[0] === publicIds[1] ? 'Tied post A' : 'Tied post B',
      createdAt: '2026-10-21T12:00:00.000000Z',
      authorId: ownerId,
      authorUsername: ownerUsername,
      imageUrl: `/posts/${expectedTiedIds[0]}/image`,
      likeCount: 0,
      likedByMe: false,
    });
    expect(first.body.data.posts[0]).not.toHaveProperty('imageKey');
    expect(first.body.data.posts[0]).not.toHaveProperty('isPrivate');
    expect(first.body.data.nextCursor).toEqual(expect.any(String));

    const second = await owner
      .get('/api/posts')
      .query({ limit: 2, cursor: first.body.data.nextCursor });
    expect(second.status).toBe(200);
    expect(second.body.data.posts.map((post: { id: string }) => post.id)).toEqual([publicIds[0]]);
    expect(second.body.data.nextCursor).toBeNull();
    expect(
      new Set([
        ...first.body.data.posts.map((post: { id: string }) => post.id),
        ...second.body.data.posts.map((post: { id: string }) => post.id),
      ]).size,
    ).toBe(3);
  });

  it('hides private-author posts while including the authenticated owner’s own private posts', async () => {
    const privateAuthorPost = randomUUID();
    const ownerPrivatePost = randomUUID();
    const timestamp = new Date('2026-10-22T12:00:00.000Z');
    await getDatabase()
      .insert(posts)
      .values([
        {
          id: privateAuthorPost,
          userId: privateAuthorId,
          caption: 'Do not expose this metadata',
          imageKey: `${randomUUID()}.png`,
          imageContentType: 'image/png',
          createdAt: timestamp,
        },
        {
          id: ownerPrivatePost,
          userId: ownerId,
          caption: 'My own private post',
          imageKey: `${randomUUID()}.png`,
          imageContentType: 'image/png',
          createdAt: timestamp,
        },
      ]);
    await getDatabase().update(users).set({ isPrivate: true }).where(eq(users.id, ownerId));

    const response = await owner.get('/api/posts');
    expect(response.status).toBe(200);
    const returnedIds = response.body.data.posts.map((post: { id: string }) => post.id);
    expect(returnedIds).toContain(ownerPrivatePost);
    expect(returnedIds).not.toContain(privateAuthorPost);
    expect(JSON.stringify(response.body)).not.toContain('Do not expose this metadata');
  });

  it('rejects malformed cursors and invalid page sizes', async () => {
    const malformed = await owner.get('/api/posts').query({ cursor: 'not-a-valid-cursor' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_CURSOR');

    const invalidPayload = Buffer.from(
      JSON.stringify({ createdAt: 'not-a-date', id: randomUUID() }),
    ).toString('base64url');
    const invalidDate = await owner.get('/api/posts').query({ cursor: invalidPayload });
    expect(invalidDate.status).toBe(400);
    expect(invalidDate.body.error.code).toBe('INVALID_CURSOR');

    const invalidLimit = await owner.get('/api/posts').query({ limit: 0 });
    expect(invalidLimit.status).toBe(400);
    expect(invalidLimit.body.error.code).toBe('VALIDATION_ERROR');
  });
});
