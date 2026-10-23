import '../scripts/integration-test-safety.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { env } from './config/env.js';
import { closeDatabase, getDb } from './db/client.js';
import { sessions, users } from './db/schema/index.js';

type TestAgent = ReturnType<typeof request.agent>;

type TestAccount = {
  email: string;
  username: string;
  password: string;
  displayName: string;
};

const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const account: TestAccount = {
  email: `integration.${suffix}@example.test`,
  username: `it_${suffix}`,
  password: 'Integration-password-123!',
  displayName: 'Integration User',
};
const testEmails: string[] = [];
let database: NonNullable<ReturnType<typeof getDb>> | undefined;
let ownerAgent: TestAgent | undefined;
let ownerId: string | undefined;

function getDatabase() {
  if (!database) {
    throw new Error('Database integration tests require DATABASE_URL and the applied migrations.');
  }
  return database;
}

function getOwnerAgent() {
  if (!ownerAgent) {
    throw new Error('The registration test must create the owner session first.');
  }
  return ownerAgent;
}

function getOwnerId() {
  if (!ownerId) {
    throw new Error('The registration test must persist the owner account first.');
  }
  return ownerId;
}

async function issueCsrfToken(agent: TestAgent) {
  const response = await agent.get('/api/csrf');
  expect(response.status).toBe(200);
  const token = response.body?.data?.csrfToken;
  if (typeof token !== 'string') {
    throw new Error('The CSRF endpoint did not return a token.');
  }
  return token;
}

async function register(agent: TestAgent, values: TestAccount) {
  const token = await issueCsrfToken(agent);
  return agent
    .post('/api/auth/register')
    .set('Origin', env.WEB_ORIGIN)
    .set('x-csrf-token', token)
    .send(values);
}

async function login(agent: TestAgent, email: string, password: string) {
  const token = await issueCsrfToken(agent);
  return agent
    .post('/api/auth/login')
    .set('Origin', env.WEB_ORIGIN)
    .set('x-csrf-token', token)
    .send({ email, password });
}

async function patchWithCsrf(agent: TestAgent, path: string, body: object) {
  const token = await issueCsrfToken(agent);
  return agent
    .patch(path)
    .set('Origin', env.WEB_ORIGIN)
    .set('x-csrf-token', token)
    .send(body);
}

describe('database-backed authentication integration', () => {
  beforeAll(async () => {
    const activeDatabase = getDb();
    if (!activeDatabase) {
      throw new Error('Database integration tests require DATABASE_URL.');
    }
    database = activeDatabase;
    await activeDatabase.execute(sql`select 1`);
    await activeDatabase.select({ id: users.id }).from(users).limit(1);
  });

  afterAll(async () => {
    if (database && testEmails.length > 0) {
      await database.delete(users).where(inArray(users.email, testEmails));
    }
    await closeDatabase();
  });

  it('registers an account, persists it, and starts an authenticated session', async () => {
    testEmails.push(account.email);
    ownerAgent = request.agent(app);

    const response = await register(getOwnerAgent(), account);

    expect(response.status).toBe(201);
    expect(response.body.data.user).toMatchObject({
      email: account.email,
      username: account.username,
      displayName: account.displayName,
    });
    expect(response.body.data.user).not.toHaveProperty('passwordHash');
    ownerId = response.body.data.user.id;
    if (typeof ownerId !== 'string') {
      throw new Error('Registration did not return the created user ID.');
    }

    const persisted = await getDatabase()
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, getOwnerId()))
      .limit(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].passwordHash).not.toBe(account.password);

    const currentUser = await getOwnerAgent().get('/api/auth/me');
    expect(currentUser.status).toBe(200);
    expect(currentUser.body.data.user.id).toBe(getOwnerId());
  });

  it('rejects duplicate email or username registrations', async () => {
    const duplicateAgent = request.agent(app);
    const response = await register(duplicateAgent, {
      ...account,
      username: `dup_${suffix}`,
    });

    expect(response.status).toBe(409);

    const matchingUsers = await getDatabase()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, account.email));
    expect(matchingUsers).toHaveLength(1);

    const duplicateUsernameEmail = `integration.duplicate.${suffix}@example.test`;
    testEmails.push(duplicateUsernameEmail);
    const duplicateUsername = await register(duplicateAgent, {
      ...account,
      email: duplicateUsernameEmail,
    });
    expect(duplicateUsername.status).toBe(409);

    const duplicateUsernameAccounts = await getDatabase()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, account.username));
    expect(duplicateUsernameAccounts).toHaveLength(1);
  });

  it('logs in with a normalized email and rejects invalid credentials', async () => {
    const agent = request.agent(app);
    const invalid = await login(agent, account.email, 'incorrect-password');
    expect(invalid.status).toBe(401);

    const authenticated = await login(agent, account.email.toUpperCase(), account.password);
    expect(authenticated.status).toBe(200);
    expect(authenticated.body.data.user.email).toBe(account.email);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
  });

  it('rejects an expired database session', async () => {
    const agent = request.agent(app);
    const authenticated = await login(agent, account.email, account.password);
    expect(authenticated.status).toBe(200);

    const setCookieHeader = authenticated.headers['set-cookie'];
    const setCookies = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : setCookieHeader
        ? [setCookieHeader]
        : [];
    const sessionCookie = setCookies.find((cookie) => cookie.startsWith('lumen_session='));
    if (!sessionCookie) {
      throw new Error('Login did not issue a session cookie.');
    }
    const rawToken = sessionCookie.split(';', 1)[0].slice('lumen_session='.length);
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiredSession = await getDatabase()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });

    expect(expiredSession).toHaveLength(1);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('enforces private-profile access for non-owners', async () => {
    const owner = getOwnerAgent();
    const updated = await patchWithCsrf(owner, '/api/users/me', { isPrivate: true });
    expect(updated.status).toBe(200);
    expect(updated.body.data.user.isPrivate).toBe(true);

    // Profiles are only visible to signed-in users; redaction for signed-in
    // non-followers is covered by the follows integration suite.
    const guest = await request(app).get('/api/users').query({ username: account.username });
    expect(guest.status).toBe(401);
    expect(guest.body.error.code).toBe('UNAUTHENTICATED');

    const ownerView = await owner.get('/api/users').query({ username: account.username });
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.data.user.username).toBe(account.username);
  });

  it('updates only the authenticated owner profile', async () => {
    const otherEmail = `integration.other.${suffix}@example.test`;
    const otherUsername = `other_${suffix}`;
    testEmails.push(otherEmail);
    const [otherUser] = await getDatabase()
      .insert(users)
      .values({
        email: otherEmail,
        username: otherUsername,
        passwordHash: 'integration-test-only',
        displayName: 'Other Integration User',
      })
      .returning({ id: users.id });
    if (!otherUser) {
      throw new Error('Could not create the secondary test account.');
    }

    const changedName = `Updated ${suffix}`;
    const response = await patchWithCsrf(getOwnerAgent(), '/api/users/me', {
      displayName: changedName,
    });
    expect(response.status).toBe(200);
    expect(response.body.data.user.id).toBe(getOwnerId());
    expect(response.body.data.user.displayName).toBe(changedName);

    const otherAfter = await getDatabase()
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, otherUser.id))
      .limit(1);
    expect(otherAfter[0]).toEqual({
      id: otherUser.id,
      displayName: 'Other Integration User',
    });

    const guest = request.agent(app);
    const guestToken = await issueCsrfToken(guest);
    const unauthenticatedUpdate = await guest
      .patch('/api/users/me')
      .set('Origin', env.WEB_ORIGIN)
      .set('x-csrf-token', guestToken)
      .send({ displayName: 'Unauthorized Update' });
    expect(unauthenticatedUpdate.status).toBe(401);
  });

  it('requires correlated, same-origin, single-use CSRF tokens for profile updates', async () => {
    const agent = getOwnerAgent();
    const missingToken = await agent
      .patch('/api/users/me')
      .set('Origin', env.WEB_ORIGIN)
      .send({ bio: 'Missing token' });
    expect(missingToken.status).toBe(403);

    const foreignOriginToken = await issueCsrfToken(agent);
    const foreignOrigin = await agent
      .patch('/api/users/me')
      .set('Origin', 'https://attacker.example')
      .set('x-csrf-token', foreignOriginToken)
      .send({ bio: 'Foreign origin' });
    expect(foreignOrigin.status).toBe(403);

    const token = await issueCsrfToken(agent);
    const accepted = await agent
      .patch('/api/users/me')
      .set('Origin', env.WEB_ORIGIN)
      .set('x-csrf-token', token)
      .send({ bio: 'Accepted CSRF token' });
    expect(accepted.status).toBe(200);

    const replay = await agent
      .patch('/api/users/me')
      .set('Origin', env.WEB_ORIGIN)
      .set('x-csrf-token', token)
      .send({ bio: 'Replayed CSRF token' });
    expect(replay.status).toBe(403);

    const correlatedToken = await issueCsrfToken(agent);
    const mismatch = await agent
      .patch('/api/users/me')
      .set('Origin', env.WEB_ORIGIN)
      .set('x-csrf-token', `${correlatedToken}invalid`)
      .send({ bio: 'Mismatched CSRF token' });
    expect(mismatch.status).toBe(403);
  });

  it('revokes a session on logout', async () => {
    const owner = getOwnerAgent();
    const token = await issueCsrfToken(owner);
    const logout = await owner
      .post('/api/auth/logout')
      .set('Origin', env.WEB_ORIGIN)
      .set('x-csrf-token', token)
      .send({});

    expect(logout.status).toBe(204);
    expect((await owner.get('/api/auth/me')).status).toBe(401);
  });
});
