import '../scripts/integration-test-safety.mjs';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { env } from './config/env.js';
import { closeDatabase, getDb } from './db/client.js';
import { follows, postComments, postLikes, posts, users } from './db/schema/index.js';
import { imageStorage } from './storage/image-storage.js';

type TestAgent = ReturnType<typeof request.agent>;

const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const password = 'Follow-integration-password-123!';
const accounts = {
  follower: { email: `follow.${suffix}@example.test`, username: `fl_${suffix}` },
  secondFollower: { email: `follow.second.${suffix}@example.test`, username: `fs_${suffix}` },
  private: { email: `follow.private.${suffix}@example.test`, username: `fp_${suffix}` },
  public: { email: `follow.public.${suffix}@example.test`, username: `fu_${suffix}` },
};
const discoveryAccounts = [
  { email: `discovery.a.${suffix}@example.test`, username: `ds_${suffix}_a` },
  { email: `discovery.b.${suffix}@example.test`, username: `ds_${suffix}_b` },
  { email: `discovery.c.${suffix}@example.test`, username: `ds_${suffix}_c` },
];
const discoveryPostIds = [randomUUID(), randomUUID()];
const privatePostId = randomUUID();
const privateImageKey = `${randomUUID()}.png`;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=',
  'base64',
);
let database: NonNullable<ReturnType<typeof getDb>> | undefined;
let follower: TestAgent;
let secondFollower: TestAgent;
let privateOwner: TestAgent;
let publicOwner: TestAgent;
let followerId: string;
let secondFollowerUserId: string;
let privateOwnerId: string;
let publicOwnerId: string;

function db() {
  if (!database) throw new Error('Follow integration tests require DATABASE_URL and migrations.');
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
    .send({
      ...account,
      password,
      displayName: account.username,
    });
}

async function login(agent: TestAgent, email: string) {
  const token = await csrf(agent);
  return agent
    .post('/api/auth/login')
    .set('Origin', env.WEB_ORIGIN)
    .set('x-csrf-token', token)
    .send({ email, password });
}

async function mutate(
  agent: TestAgent,
  method: 'put' | 'delete' | 'post' | 'patch',
  path: string,
  body?: object,
) {
  const token = await csrf(agent);
  const call = agent[method](path).set('Origin', env.WEB_ORIGIN).set('x-csrf-token', token);
  return body ? call.send(body) : call;
}

describe('follow relationships and private profile access', () => {
  beforeAll(async () => {
    const activeDatabase = getDb();
    if (!activeDatabase) throw new Error('Follow integration tests require DATABASE_URL.');
    database = activeDatabase;
    await activeDatabase.execute(sql`select 1`);
    await activeDatabase.select({ id: follows.followerId }).from(follows).limit(1);

    follower = request.agent(app);
    secondFollower = request.agent(app);
    privateOwner = request.agent(app);
    publicOwner = request.agent(app);
    const [followerRegistration, secondRegistration, privateRegistration, publicRegistration] =
      await Promise.all([
        register(follower, accounts.follower),
        register(secondFollower, accounts.secondFollower),
        register(privateOwner, accounts.private),
        register(publicOwner, accounts.public),
      ]);
    expect(followerRegistration.status).toBe(201);
    expect(secondRegistration.status).toBe(201);
    expect(privateRegistration.status).toBe(201);
    expect(publicRegistration.status).toBe(201);
    followerId = followerRegistration.body.data.user.id as string;
    secondFollowerUserId = secondRegistration.body.data.user.id as string;
    privateOwnerId = privateRegistration.body.data.user.id as string;
    publicOwnerId = publicRegistration.body.data.user.id as string;

    await activeDatabase.update(users).set({ isPrivate: true }).where(eq(users.id, privateOwnerId));
    await activeDatabase.insert(users).values(
      discoveryAccounts.map((account, index) => ({
        ...account,
        passwordHash: 'discovery-test-only',
        displayName: `Discovery private detail ${index}`,
        bio: `Private discovery bio ${index}`,
        avatarUrl: `https://example.test/private-${index}.png`,
        isPrivate: index === 1,
      })),
    );
    const [discoveryAuthor] = await activeDatabase
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, discoveryAccounts[0].username))
      .limit(1);
    if (!discoveryAuthor) throw new Error('Could not load the discovery author fixture.');
    await activeDatabase.insert(posts).values([
      {
        id: discoveryPostIds[0],
        userId: discoveryAuthor.id,
        caption: 'Discovery post older',
        imageKey: `${randomUUID()}.png`,
        imageContentType: 'image/png',
        createdAt: new Date('2026-10-20T12:00:00.000Z'),
      },
      {
        id: discoveryPostIds[1],
        userId: discoveryAuthor.id,
        caption: 'Discovery post newer',
        imageKey: `${randomUUID()}.png`,
        imageContentType: 'image/png',
        createdAt: new Date('2026-10-21T12:00:00.000Z'),
      },
    ]);
    await activeDatabase.insert(posts).values({
      id: privatePostId,
      userId: privateOwnerId,
      caption: 'Restricted fixture post',
      imageKey: privateImageKey,
      imageContentType: 'image/png',
    });
    await activeDatabase
      .insert(postComments)
      .values({ postId: privatePostId, userId: privateOwnerId, text: 'Owner-only comment' });
    await imageStorage.put(privateImageKey, png);
  });

  afterAll(async () => {
    await imageStorage.remove(privateImageKey);
    if (database) {
      await database
        .delete(users)
        .where(
          inArray(users.email, [
            ...Object.values(accounts).map((account) => account.email),
            ...discoveryAccounts.map((account) => account.email),
          ]),
        );
    }
    await closeDatabase();
  });

  it('searches usernames case-insensitively with bounded cursor pages and safe privacy fields', async () => {
    const unauthenticated = await request(app)
      .get('/api/users/discover')
      .query({ q: discoveryAccounts[0].username.slice(0, 8) });
    expect(unauthenticated.status).toBe(401);

    const query = `DS_${suffix}`.toUpperCase();
    const first = await follower.get('/api/users/discover').query({ q: query, limit: 2 });
    expect(first.status).toBe(200);
    expect(first.body.data.users.map((user: { username: string }) => user.username)).toEqual(
      discoveryAccounts.slice(0, 2).map((account) => account.username),
    );
    expect(first.body.data.users[0]).toMatchObject({
      username: discoveryAccounts[0].username,
      displayName: 'Discovery private detail 0',
      isPrivate: false,
      followState: 'none',
    });
    expect(first.body.data.users[0]).not.toHaveProperty('email');
    expect(first.body.data.users[0]).not.toHaveProperty('passwordHash');
    expect(first.body.data.users[0]).not.toHaveProperty('id');
    expect(first.body.data.users[1]).toEqual({
      username: discoveryAccounts[1].username,
      isPrivate: true,
      followState: 'none',
    });
    expect(JSON.stringify(first.body)).not.toContain('Private discovery bio');
    expect(first.body.data.nextCursor).toEqual(expect.any(String));

    const second = await follower
      .get('/api/users/discover')
      .query({ q: query, limit: 2, cursor: first.body.data.nextCursor });
    expect(second.status).toBe(200);
    expect(second.body.data.users.map((user: { username: string }) => user.username)).toEqual([
      discoveryAccounts[2].username,
    ]);
    expect(second.body.data.nextCursor).toBeNull();

    const publicProfilePosts = await follower
      .get(`/api/users/${discoveryAccounts[0].username}/posts`)
      .query({ limit: 1 });
    expect(publicProfilePosts.body.data.posts.map((post: { id: string }) => post.id)).toEqual([
      discoveryPostIds[1],
    ]);
    expect(publicProfilePosts.body.data.nextCursor).toEqual(expect.any(String));
    const nextProfilePosts = await follower
      .get(`/api/users/${discoveryAccounts[0].username}/posts`)
      .query({ limit: 1, cursor: publicProfilePosts.body.data.nextCursor });
    expect(nextProfilePosts.body.data.posts.map((post: { id: string }) => post.id)).toEqual([
      discoveryPostIds[0],
    ]);
    expect(nextProfilePosts.body.data.nextCursor).toBeNull();

    const selfSearch = await follower
      .get('/api/users/discover')
      .query({ q: accounts.follower.username.slice(0, 8) });
    expect(selfSearch.body.data.users.map((user: { username: string }) => user.username)).not.toContain(
      accounts.follower.username,
    );

    const malformedQuery = await follower.get('/api/users/discover').query({ q: 'x' });
    const invalidCharacter = await follower.get('/api/users/discover').query({ q: 'ab%' });
    const oversizedPage = await follower
      .get('/api/users/discover')
      .query({ q: query, limit: 31 });
    const invalidCursor = await follower
      .get('/api/users/discover')
      .query({ q: query, cursor: 'invalid-cursor' });
    const mismatchedCursorValue = Buffer.from(
      JSON.stringify({
        query: 'different',
        username: discoveryAccounts[0].username,
        id: randomUUID(),
      }),
    ).toString('base64url');
    const mismatchedCursor = await follower
      .get('/api/users/discover')
      .query({ q: query, cursor: mismatchedCursorValue });
    expect(malformedQuery.status).toBe(400);
    expect(invalidCharacter.status).toBe(400);
    expect(oversizedPage.status).toBe(400);
    expect(invalidCursor.status).toBe(400);
    expect(invalidCursor.body.error.code).toBe('INVALID_CURSOR');
    expect(mismatchedCursor.status).toBe(400);
  });

  it('rejects self-follow and immediately accepts public follows idempotently', async () => {
    const self = await mutate(follower, 'put', `/api/users/${accounts.follower.username}/follow`);
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe('SELF_FOLLOW');

    const repeated = [
      await mutate(follower, 'put', `/api/users/${accounts.public.username}/follow`),
      await mutate(follower, 'put', `/api/users/${accounts.public.username}/follow`),
    ];
    expect(repeated.map((response) => response.status)).toEqual([200, 200]);
    expect(repeated.map((response) => response.body.data.followState)).toEqual(['following', 'following']);
    const relation = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(follows)
      .where(and(eq(follows.followerId, followerId), eq(follows.followedId, publicOwnerId)));
    expect(relation[0].count).toBe(1);

    const publicProfile = await follower.get('/api/users').query({ username: accounts.public.username });
    expect(publicProfile.body.data.user).toMatchObject({
      followerCount: 1,
      followState: 'following',
    });
    const unfollow = await mutate(follower, 'delete', `/api/users/${accounts.public.username}/follow`);
    const repeatedUnfollow = await mutate(
      follower,
      'delete',
      `/api/users/${accounts.public.username}/follow`,
    );
    expect(unfollow.body.data.followState).toBe('none');
    expect(repeatedUnfollow.body.data.followState).toBe('none');

    const secondSession = request.agent(app);
    expect((await login(secondSession, accounts.secondFollower.email)).status).toBe(200);
    const concurrent = await Promise.all([
      mutate(secondFollower, 'put', `/api/users/${accounts.public.username}/follow`),
      mutate(secondSession, 'put', `/api/users/${accounts.public.username}/follow`),
    ]);
    expect(concurrent.map((response) => response.body.data.followState)).toEqual([
      'following',
      'following',
    ]);
    const concurrentRows = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(follows)
      .where(
        and(
          eq(follows.followerId, secondFollowerUserId),
          eq(follows.followedId, publicOwnerId),
        ),
      );
    expect(concurrentRows[0].count).toBe(1);
  });

  it('keeps pending private requests hidden until approved across feed, posts, images, likes and comments', async () => {
    const requestResponse = await mutate(
      follower,
      'put',
      `/api/users/${accounts.private.username}/follow`,
    );
    const repeated = await mutate(follower, 'put', `/api/users/${accounts.private.username}/follow`);
    expect(requestResponse.body.data.followState).toBe('pending');
    expect(repeated.body.data.followState).toBe('pending');
    const relationship = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(follows)
      .where(and(eq(follows.followerId, followerId), eq(follows.followedId, privateOwnerId)));
    expect(relationship[0].count).toBe(1);

    const preview = await follower
      .get('/api/users')
      .query({ username: accounts.private.username });
    expect(preview.body.data.user).toEqual({
      username: accounts.private.username,
      isPrivate: true,
      followState: 'pending',
      followerCount: null,
      followingCount: null,
    });
    expect(JSON.stringify(preview.body)).not.toContain('Owner-only comment');

    const feed = await follower.get('/api/posts');
    const listing = await follower.get(`/api/users/${accounts.private.username}/posts`);
    const image = await follower.get(`/api/posts/${privatePostId}/image`);
    const comments = await follower.get(`/api/posts/${privatePostId}/comments`);
    const like = await mutate(follower, 'put', `/api/posts/${privatePostId}/like`);
    const comment = await mutate(follower, 'post', `/api/posts/${privatePostId}/comments`, {
      text: 'Not yet',
    });
    expect(feed.body.data.posts.map((post: { id: string }) => post.id)).not.toContain(privatePostId);
    expect(listing.body.data.posts).toEqual([]);
    expect(image.status).toBe(404);
    expect(comments.status).toBe(404);
    expect(like.status).toBe(404);
    expect(comment.status).toBe(404);

    const pending = await privateOwner.get('/api/users/me/follow-requests');
    expect(pending.body.data.requests).toMatchObject([
      { id: followerId, username: accounts.follower.username },
    ]);
    const approved = await mutate(
      privateOwner,
      'put',
      `/api/users/follow-requests/${followerId}/approve`,
    );
    expect(approved.body.data.status).toBe('accepted');

    const authorizedProfile = await follower
      .get('/api/users')
      .query({ username: accounts.private.username });
    expect(authorizedProfile.body.data.user).toMatchObject({
      bio: null,
      followerCount: 1,
      followState: 'following',
    });
    const [authorizedFeed, authorizedListing, authorizedImage, authorizedComments, authorizedLike] =
      await Promise.all([
        follower.get('/api/posts'),
        follower.get(`/api/users/${accounts.private.username}/posts`),
        follower.get(`/api/posts/${privatePostId}/image`),
        follower.get(`/api/posts/${privatePostId}/comments`),
        mutate(follower, 'put', `/api/posts/${privatePostId}/like`),
      ]);
    expect(authorizedFeed.body.data.posts.map((post: { id: string }) => post.id)).toContain(
      privatePostId,
    );
    expect(authorizedListing.body.data.posts.map((post: { id: string }) => post.id)).toEqual([
      privatePostId,
    ]);
    expect(authorizedImage.status).toBe(200);
    expect(authorizedComments.body.data.comments[0].text).toBe('Owner-only comment');
    expect(authorizedLike.body.data).toMatchObject({ liked: true, likeCount: 1 });
    const followerComment = await mutate(
      follower,
      'post',
      `/api/posts/${privatePostId}/comments`,
      { text: 'Approved follower comment' },
    );
    expect(followerComment.status).toBe(201);
    expect(followerComment.body.data.comment.text).toBe('Approved follower comment');
    const deleteOwnComment = await mutate(
      follower,
      'delete',
      `/api/posts/${privatePostId}/comments/${followerComment.body.data.comment.id}`,
    );
    expect(deleteOwnComment.status).toBe(204);

    await mutate(follower, 'delete', `/api/users/${accounts.private.username}/follow`);
    const revokedImage = await follower.get(`/api/posts/${privatePostId}/image`);
    const revokedComments = await follower.get(`/api/posts/${privatePostId}/comments`);
    const revokedLike = await mutate(follower, 'put', `/api/posts/${privatePostId}/like`);
    const revokedComment = await mutate(follower, 'post', `/api/posts/${privatePostId}/comments`, {
      text: 'Access revoked',
    });
    expect(revokedImage.status).toBe(404);
    expect(revokedComments.status).toBe(404);
    expect(revokedLike.status).toBe(404);
    expect(revokedComment.status).toBe(404);
    const counts = await privateOwner.get('/api/users').query({ username: accounts.private.username });
    expect(counts.body.data.user.followerCount).toBe(0);
  });

  it('lets an owner reject requests and permits a later retry', async () => {
    const created = await mutate(
      secondFollower,
      'put',
      `/api/users/${accounts.private.username}/follow`,
    );
    expect(created.body.data.followState).toBe('pending');
    const rejected = await mutate(
      privateOwner,
      'delete',
      `/api/users/follow-requests/${secondFollowerUserId}`,
    );
    expect(rejected.status).toBe(204);
    const rejectedProfile = await secondFollower
      .get('/api/users')
      .query({ username: accounts.private.username });
    expect(rejectedProfile.body.data.user.followState).toBe('none');
    const retry = await mutate(
      secondFollower,
      'put',
      `/api/users/${accounts.private.username}/follow`,
    );
    expect(retry.body.data.followState).toBe('pending');
  });

  it('accepts existing requests when a private account becomes public', async () => {
    await db().update(users).set({ isPrivate: true }).where(eq(users.id, privateOwnerId));
    const requested = await mutate(
      secondFollower,
      'put',
      `/api/users/${accounts.private.username}/follow`,
    );
    expect(requested.body.data.followState).toBe('pending');
    await mutate(privateOwner, 'patch', '/api/users/me', { isPrivate: false });
    const profile = await secondFollower
      .get('/api/users')
      .query({ username: accounts.private.username });
    expect(profile.body.data.user.followState).toBe('following');
    expect(profile.body.data.user.followerCount).toBe(1);
  });

  it('retains accepted access when an account becomes private without granting pending access', async () => {
    await mutate(secondFollower, 'delete', `/api/users/${accounts.private.username}/follow`);
    const acceptedWhilePublic = await mutate(
      follower,
      'put',
      `/api/users/${accounts.private.username}/follow`,
    );
    expect(acceptedWhilePublic.body.data.followState).toBe('following');

    await db().update(users).set({ isPrivate: true }).where(eq(users.id, privateOwnerId));
    const pendingWhilePrivate = await mutate(
      secondFollower,
      'put',
      `/api/users/${accounts.private.username}/follow`,
    );
    expect(pendingWhilePrivate.body.data.followState).toBe('pending');

    const acceptedProfile = await follower
      .get('/api/users')
      .query({ username: accounts.private.username });
    expect(acceptedProfile.body.data.user).toMatchObject({
      displayName: accounts.private.username,
      followerCount: 1,
      followState: 'following',
    });
    expect((await follower.get(`/api/users/${accounts.private.username}/posts`)).body.data.posts)
      .toHaveLength(1);
    expect((await follower.get(`/api/posts/${privatePostId}/image`)).status).toBe(200);
    const ownerPosts = await privateOwner.get(`/api/users/${accounts.private.username}/posts`);
    expect(ownerPosts.body.data.posts.map((post: { id: string }) => post.id)).toContain(
      privatePostId,
    );

    const pendingProfile = await secondFollower
      .get('/api/users')
      .query({ username: accounts.private.username });
    expect(pendingProfile.body.data.user).toEqual({
      username: accounts.private.username,
      isPrivate: true,
      followState: 'pending',
      followerCount: null,
      followingCount: null,
    });
    expect(
      (await secondFollower.get(`/api/users/${accounts.private.username}/posts`)).body.data.posts,
    ).toEqual([]);
    expect((await secondFollower.get(`/api/posts/${privatePostId}/image`)).status).toBe(404);
  });
});
