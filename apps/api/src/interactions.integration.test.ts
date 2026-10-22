import '../scripts/integration-test-safety.mjs';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { env } from './config/env.js';
import { closeDatabase, getDb } from './db/client.js';
import { postComments, postLikes, posts, users } from './db/schema/index.js';

type TestAgent = ReturnType<typeof request.agent>;

const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const ownerEmail = `interactions.${suffix}@example.test`;
const ownerUsername = `ix_${suffix}`;
const otherEmail = `interactions.other.${suffix}@example.test`;
const otherUsername = `iy_${suffix}`;
const privateEmail = `interactions.private.${suffix}@example.test`;
const privateUsername = `iz_${suffix}`;
const password = 'Interaction-integration-password-123!';
const visiblePostId = randomUUID();
const privatePostId = randomUUID();
const fixedCommentIds = [randomUUID(), randomUUID()];
let database: NonNullable<ReturnType<typeof getDb>> | undefined;
let owner: TestAgent;
let other: TestAgent;
let ownerId: string;
let otherId: string;
let privateUserId: string;

function getDatabase() {
  if (!database) {
    throw new Error('Interaction integration tests require DATABASE_URL and applied migrations.');
  }
  return database;
}

async function csrf(agent: TestAgent) {
  const response = await agent.get('/api/csrf');
  expect(response.status).toBe(200);
  return response.body.data.csrfToken as string;
}

async function register(agent: TestAgent, email: string, username: string) {
  const token = await csrf(agent);
  return agent
    .post('/api/auth/register')
    .set('Origin', env.WEB_ORIGIN)
    .set('x-csrf-token', token)
    .send({ email, username, password, displayName: username });
}

async function mutate(
  agent: TestAgent,
  method: 'put' | 'delete' | 'post',
  path: string,
  body?: object,
) {
  const token = await csrf(agent);
  const call = agent[method](path).set('Origin', env.WEB_ORIGIN).set('x-csrf-token', token);
  return body ? call.send(body) : call;
}

describe('post likes and comments integration', () => {
  beforeAll(async () => {
    const activeDatabase = getDb();
    if (!activeDatabase) throw new Error('Interaction integration tests require DATABASE_URL.');
    database = activeDatabase;
    await activeDatabase.execute(sql`select 1`);
    await activeDatabase.select({ id: postComments.id }).from(postComments).limit(1);

    owner = request.agent(app);
    const ownerRegistration = await register(owner, ownerEmail, ownerUsername);
    expect(ownerRegistration.status).toBe(201);
    ownerId = ownerRegistration.body.data.user.id as string;

    other = request.agent(app);
    const otherRegistration = await register(other, otherEmail, otherUsername);
    expect(otherRegistration.status).toBe(201);
    otherId = otherRegistration.body.data.user.id as string;

    const [privateUser] = await activeDatabase
      .insert(users)
      .values({
        email: privateEmail,
        username: privateUsername,
        passwordHash: 'integration-test-only',
        displayName: 'Private Interaction User',
        isPrivate: true,
      })
      .returning({ id: users.id });
    if (!privateUser) throw new Error('Could not create private interaction user.');
    privateUserId = privateUser.id;

    await activeDatabase.insert(posts).values([
      {
        id: visiblePostId,
        userId: ownerId,
        caption: 'Visible interaction fixture',
        imageKey: `${randomUUID()}.png`,
        imageContentType: 'image/png',
      },
      {
        id: privatePostId,
        userId: privateUserId,
        caption: 'Private interaction fixture',
        imageKey: `${randomUUID()}.png`,
        imageContentType: 'image/png',
      },
    ]);
  });

  afterAll(async () => {
    if (database) {
      await database.delete(users).where(eq(users.email, ownerEmail));
      await database.delete(users).where(eq(users.email, otherEmail));
      await database.delete(users).where(eq(users.email, privateEmail));
    }
    await closeDatabase();
  });

  it('requires authentication and hides interactions on another private profile', async () => {
    const guest = request.agent(app);
    const unauthenticated = await guest.get(`/api/posts/${visiblePostId}/comments`);
    expect(unauthenticated.status).toBe(401);

    const privateLike = await mutate(other, 'put', `/api/posts/${privatePostId}/like`);
    expect(privateLike.status).toBe(404);
    const privateComments = await other.get(`/api/posts/${privatePostId}/comments`);
    expect(privateComments.status).toBe(404);
    const privateComment = await mutate(other, 'post', `/api/posts/${privatePostId}/comments`, {
      text: 'Not allowed',
    });
    expect(privateComment.status).toBe(404);
  });

  it('handles repeated and concurrent likes without duplicates and returns accurate counts', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => mutate(owner, 'put', `/api/posts/${visiblePostId}/like`)),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses[responses.length - 1].body.data.liked).toBe(true);

    const duplicates = await getDatabase()
      .select({ count: sql<number>`count(*)::int` })
      .from(postLikes)
      .where(and(eq(postLikes.userId, ownerId), eq(postLikes.postId, visiblePostId)));
    expect(duplicates[0].count).toBe(1);

    const feed = await owner.get('/api/posts');
    const feedPost = feed.body.data.posts.find((post: { id: string }) => post.id === visiblePostId);
    expect(feedPost).toMatchObject({ likeCount: 1, likedByMe: true });

    const firstUnlike = await mutate(owner, 'delete', `/api/posts/${visiblePostId}/like`);
    const repeatedUnlike = await mutate(owner, 'delete', `/api/posts/${visiblePostId}/like`);
    expect(firstUnlike.body.data).toEqual({ liked: false, likeCount: 0 });
    expect(repeatedUnlike.body.data).toEqual({ liked: false, likeCount: 0 });
    const otherLike = await mutate(other, 'put', `/api/posts/${visiblePostId}/like`);
    expect(otherLike.body.data).toEqual({ liked: true, likeCount: 1 });
  });

  it('trims comments, rejects invalid text, paginates newest-first, and enforces author ownership on delete', async () => {
    const blank = await mutate(other, 'post', `/api/posts/${visiblePostId}/comments`, {
      text: '   ',
    });
    expect(blank.status).toBe(400);
    expect(blank.body.error.code).toBe('VALIDATION_ERROR');

    const tooLong = await mutate(other, 'post', `/api/posts/${visiblePostId}/comments`, {
      text: 'x'.repeat(1001),
    });
    expect(tooLong.status).toBe(400);

    const created = await mutate(other, 'post', `/api/posts/${visiblePostId}/comments`, {
      text: '  A helpful comment  ',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.comment).toMatchObject({
      text: 'A helpful comment',
      authorId: otherId,
      authorUsername: otherUsername,
    });

    await getDatabase()
      .insert(postComments)
      .values([
        {
          id: fixedCommentIds[0],
          postId: visiblePostId,
          userId: ownerId,
          text: 'Older fixture comment A',
          createdAt: new Date('2026-10-19T10:00:00.000Z'),
        },
        {
          id: fixedCommentIds[1],
          postId: visiblePostId,
          userId: ownerId,
          text: 'Older fixture comment B',
          createdAt: new Date('2026-10-19T10:00:00.000Z'),
        },
      ]);

    const first = await owner.get(`/api/posts/${visiblePostId}/comments`).query({ limit: 1 });
    expect(first.status).toBe(200);
    expect(first.body.data.comments[0].text).toBe('A helpful comment');
    expect(first.body.data.nextCursor).toEqual(expect.any(String));
    const page = await owner
      .get(`/api/posts/${visiblePostId}/comments`)
      .query({ limit: 1, cursor: first.body.data.nextCursor });
    expect(page.status).toBe(200);
    expect(page.body.data.comments).toHaveLength(1);
    expect(page.body.data.comments[0].text).toMatch(/^Older fixture comment/);
    expect(page.body.data.nextCursor).toEqual(expect.any(String));

    const someoneElsesComment = await mutate(
      owner,
      'delete',
      `/api/posts/${visiblePostId}/comments/${created.body.data.comment.id}`,
    );
    expect(someoneElsesComment.status).toBe(404);

    const ownComment = await mutate(
      other,
      'delete',
      `/api/posts/${visiblePostId}/comments/${created.body.data.comment.id}`,
    );
    expect(ownComment.status).toBe(204);
  });

  it('rejects invalid cursors and CSRF-less like/comment mutations', async () => {
    const invalidCursor = await owner
      .get(`/api/posts/${visiblePostId}/comments`)
      .query({ cursor: 'invalid-cursor' });
    expect(invalidCursor.status).toBe(400);
    expect(invalidCursor.body.error.code).toBe('INVALID_CURSOR');

    const missingCsrf = await owner
      .put(`/api/posts/${visiblePostId}/like`)
      .set('Origin', env.WEB_ORIGIN);
    expect(missingCsrf.status).toBe(403);
  });
});
