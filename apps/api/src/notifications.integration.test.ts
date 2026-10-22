import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { env } from './config/env.js';
import { closeDatabase, getDb } from './db/client.js';
import { follows, notifications, posts, users } from './db/schema/index.js';

type TestAgent = ReturnType<typeof request.agent>;

const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const password = 'Notification-integration-password-123!';
const accounts = {
  owner: { email: `notifications.owner.${suffix}@example.test`, username: `no_${suffix}` },
  actor: { email: `notifications.actor.${suffix}@example.test`, username: `na_${suffix}` },
  privateOwner: {
    email: `notifications.private.${suffix}@example.test`,
    username: `np_${suffix}`,
  },
  outsider: {
    email: `notifications.outsider.${suffix}@example.test`,
    username: `nx_${suffix}`,
  },
};
const ownerPostId = randomUUID();
const privatePostId = randomUUID();
let database: NonNullable<ReturnType<typeof getDb>> | undefined;
let owner: TestAgent;
let actor: TestAgent;
let privateOwner: TestAgent;
let outsider: TestAgent;
let ownerId: string;
let actorId: string;
let privateOwnerId: string;
let outsiderId: string;

function db() {
  if (!database) {
    throw new Error('Notification integration tests require DATABASE_URL and applied migrations.');
  }
  return database;
}

async function csrf(agent: TestAgent) {
  const response = await agent.get('/api/csrf');
  expect(response.status).toBe(200);
  return response.body.data.csrfToken as string;
}

async function register(agent: TestAgent, account: { email: string; username: string }) {
  const token = await csrf(agent);
  return agent
    .post('/api/auth/register')
    .set('Origin', env.WEB_ORIGIN)
    .set('x-csrf-token', token)
    .send({ ...account, password, displayName: account.username });
}

async function mutate(
  agent: TestAgent,
  method: 'put' | 'delete' | 'post',
  path: string,
  body?: object,
  extraHeaders: Record<string, string> = {},
) {
  const token = await csrf(agent);
  const call = agent[method](path)
    .set('Origin', env.WEB_ORIGIN)
    .set('x-csrf-token', token)
    .set(extraHeaders);
  return body ? call.send(body) : call;
}

describe('notifications integration', () => {
  beforeAll(async () => {
    const activeDatabase = getDb();
    if (!activeDatabase) throw new Error('Notification integration tests require DATABASE_URL.');
    database = activeDatabase;
    await activeDatabase.execute(sql`select 1`);
    await activeDatabase.select({ id: notifications.id }).from(notifications).limit(1);

    owner = request.agent(app);
    actor = request.agent(app);
    privateOwner = request.agent(app);
    outsider = request.agent(app);
    const registrations = await Promise.all([
      register(owner, accounts.owner),
      register(actor, accounts.actor),
      register(privateOwner, accounts.privateOwner),
      register(outsider, accounts.outsider),
    ]);
    expect(registrations.map((result) => result.status)).toEqual([201, 201, 201, 201]);
    [ownerId, actorId, privateOwnerId, outsiderId] = registrations.map(
      (result) => result.body.data.user.id as string,
    );

    await activeDatabase
      .update(users)
      .set({ isPrivate: true })
      .where(eq(users.id, privateOwnerId));
    await activeDatabase.insert(posts).values([
      {
        id: ownerPostId,
        userId: ownerId,
        caption: 'Notification post caption must not be exposed.',
        imageKey: `${randomUUID()}.png`,
        imageContentType: 'image/png',
      },
      {
        id: privatePostId,
        userId: privateOwnerId,
        caption: 'Private notification caption must not be exposed.',
        imageKey: `${randomUUID()}.png`,
        imageContentType: 'image/png',
      },
    ]);
  });

  afterAll(async () => {
    if (database) {
      for (const account of Object.values(accounts)) {
        await database.delete(users).where(eq(users.email, account.email));
      }
    }
    await closeDatabase();
  });

  it('records new like and comment events once, excludes self-actions, and omits content', async () => {
    await mutate(actor, 'put', `/api/posts/${ownerPostId}/like`);
    await mutate(actor, 'put', `/api/posts/${ownerPostId}/like`);
    const commentKey = randomUUID();
    const firstComment = await mutate(
      actor,
      'post',
      `/api/posts/${ownerPostId}/comments`,
      { text: 'A private comment body.' },
      { 'Idempotency-Key': commentKey },
    );
    const retriedComment = await mutate(
      actor,
      'post',
      `/api/posts/${ownerPostId}/comments`,
      { text: 'A private comment body.' },
      { 'Idempotency-Key': commentKey },
    );
    expect(firstComment.status).toBe(201);
    expect(retriedComment.status).toBe(201);
    expect(retriedComment.body.data.comment.id).toBe(firstComment.body.data.comment.id);
    const reusedKey = await mutate(
      actor,
      'post',
      `/api/posts/${ownerPostId}/comments`,
      { text: 'Different text.' },
      { 'Idempotency-Key': commentKey },
    );
    expect(reusedKey.status).toBe(409);

    await mutate(owner, 'put', `/api/posts/${ownerPostId}/like`);
    await mutate(owner, 'post', `/api/posts/${ownerPostId}/comments`, { text: 'Self comment.' });

    const response = await owner.get('/api/notifications');
    expect(response.status).toBe(200);
    expect(response.body.data.notifications).toHaveLength(2);
    expect(response.body.data.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'like',
          actorUsername: accounts.actor.username,
          postId: ownerPostId,
          resourceUrl: `/posts/${ownerPostId}/image`,
        }),
        expect.objectContaining({
          type: 'comment',
          actorUsername: accounts.actor.username,
          postId: ownerPostId,
          resourceUrl: `/posts/${ownerPostId}/image`,
        }),
      ]),
    );
    const publicJson = JSON.stringify(response.body);
    expect(publicJson).not.toContain('Notification post caption');
    expect(publicJson).not.toContain('A private comment body');
    const commentRows = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, ownerId),
          eq(notifications.type, 'comment'),
        ),
      );
    expect(commentRows[0].count).toBe(1);
  });

  it('records public follows, private requests, and approvals once', async () => {
    await mutate(actor, 'put', `/api/users/${accounts.owner.username}/follow`);
    await mutate(actor, 'put', `/api/users/${accounts.owner.username}/follow`);
    await mutate(actor, 'put', `/api/users/${accounts.privateOwner.username}/follow`);
    await mutate(actor, 'put', `/api/users/${accounts.privateOwner.username}/follow`);

    const ownerNotifications = await owner.get('/api/notifications');
    expect(ownerNotifications.body.data.notifications).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'follow' })]),
    );
    expect(
      ownerNotifications.body.data.notifications.filter(
        (notification: { type: string }) => notification.type === 'follow',
      ),
    ).toHaveLength(1);

    const pendingNotifications = await privateOwner.get('/api/notifications');
    expect(
      pendingNotifications.body.data.notifications.filter(
        (notification: { type: string }) => notification.type === 'follow_request',
      ),
    ).toHaveLength(1);
    expect(
      pendingNotifications.body.data.notifications.some(
        (notification: { postId: string | null; resourceUrl: string | null }) =>
          notification.postId === privatePostId || notification.resourceUrl !== null,
      ),
    ).toBe(false);

    const firstApproval = await mutate(
      privateOwner,
      'put',
      `/api/users/follow-requests/${actorId}/approve`,
    );
    const repeatedApproval = await mutate(
      privateOwner,
      'put',
      `/api/users/follow-requests/${actorId}/approve`,
    );
    expect(firstApproval.status).toBe(200);
    expect(repeatedApproval.status).toBe(404);
    const actorNotifications = await actor.get('/api/notifications');
    expect(
      actorNotifications.body.data.notifications.filter(
        (notification: { type: string }) => notification.type === 'follow_approved',
      ),
    ).toHaveLength(1);

    const followRows = await db()
      .select({ status: follows.status })
      .from(follows)
      .where(and(eq(follows.followerId, actorId), eq(follows.followedId, ownerId)));
    expect(followRows[0].status).toBe('accepted');
  });

  it('paginates by recipient, hides unauthorized private resources, and enforces read ownership', async () => {
    const fixtureNotifications = Array.from({ length: 3 }, (_, index) => ({
      recipientId: outsiderId,
      actorId,
      type: 'follow',
      relatedUserId: actorId,
      createdAt: new Date(Date.now() - index * 1000),
    }));
    await db().insert(notifications).values([
      ...fixtureNotifications,
      {
        recipientId: outsiderId,
        actorId,
        type: 'like',
        postId: privatePostId,
      },
    ]);
    const firstPage = await outsider.get('/api/notifications?limit=2');
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data.notifications).toHaveLength(2);
    expect(firstPage.body.data.nextCursor).toEqual(expect.any(String));
    const invalidCursor = await outsider.get('/api/notifications?cursor=not-a-cursor');
    expect(invalidCursor.status).toBe(400);
    expect(invalidCursor.body.error.code).toBe('INVALID_CURSOR');
    const secondPage = await outsider.get(
      `/api/notifications?limit=2&cursor=${encodeURIComponent(firstPage.body.data.nextCursor)}`,
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data.notifications).toHaveLength(2);
    expect(
      firstPage.body.data.notifications.some(
        (notification: { postId: string | null; resourceUrl: string | null }) =>
          notification.postId === privatePostId || notification.resourceUrl !== null,
      ),
    ).toBe(false);

    const notificationToRead = firstPage.body.data.notifications[0];
    const denied = await mutate(
      owner,
      'put',
      `/api/notifications/${notificationToRead.id}/read`,
    );
    expect(denied.status).toBe(404);
    const marked = await mutate(
      outsider,
      'put',
      `/api/notifications/${notificationToRead.id}/read`,
    );
    expect(marked.status).toBe(200);
    expect(marked.body.data.readAt).toEqual(expect.any(String));
    const repeatedMark = await mutate(
      outsider,
      'put',
      `/api/notifications/${notificationToRead.id}/read`,
    );
    expect(repeatedMark.body.data.readAt).toBe(marked.body.data.readAt);
    const guest = await request(app).get('/api/notifications');
    expect(guest.status).toBe(401);
    const guestRead = await mutate(request.agent(app), 'put', `/api/notifications/${notificationToRead.id}/read`);
    expect(guestRead.status).toBe(401);
  });
});
