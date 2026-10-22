import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { env } from './config/env.js';
import { closeDatabase, getDb } from './db/client.js';
import {
  conversationParticipants,
  conversations,
  messages,
  users,
} from './db/schema/index.js';

type TestAgent = ReturnType<typeof request.agent>;

const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const password = 'Messages-integration-password-123!';
const accounts = {
  sender: { email: `messages.sender.${suffix}@example.test`, username: `ms_${suffix}` },
  recipient: { email: `messages.recipient.${suffix}@example.test`, username: `mr_${suffix}` },
  outsider: { email: `messages.outsider.${suffix}@example.test`, username: `mo_${suffix}` },
  other: { email: `messages.other.${suffix}@example.test`, username: `mx_${suffix}` },
};
let database: NonNullable<ReturnType<typeof getDb>> | undefined;
let sender: TestAgent;
let recipient: TestAgent;
let outsider: TestAgent;
let other: TestAgent;
let senderId: string;
let recipientId: string;
let outsiderId: string;
let otherId: string;
let conversationId: string;
let initialMessageKey: string;

function db() {
  if (!database) {
    throw new Error('Messaging integration tests require DATABASE_URL and applied migrations.');
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
  method: 'put' | 'post',
  path: string,
  body?: object,
) {
  const token = await csrf(agent);
  const call = agent[method](path).set('Origin', env.WEB_ORIGIN).set('x-csrf-token', token);
  return body ? call.send(body) : call;
}

function messageInput(text: string, idempotencyKey: string = randomUUID()) {
  return { text, idempotencyKey };
}

describe('direct conversations and messages integration', () => {
  beforeAll(async () => {
    const activeDatabase = getDb();
    if (!activeDatabase) throw new Error('Messaging integration tests require DATABASE_URL.');
    database = activeDatabase;
    await activeDatabase.execute(sql`select 1`);
    await activeDatabase.select({ id: conversations.id }).from(conversations).limit(1);

    sender = request.agent(app);
    recipient = request.agent(app);
    outsider = request.agent(app);
    other = request.agent(app);
    const registrations = await Promise.all([
      register(sender, accounts.sender),
      register(recipient, accounts.recipient),
      register(outsider, accounts.outsider),
      register(other, accounts.other),
    ]);
    expect(registrations.map((result) => result.status)).toEqual([201, 201, 201, 201]);
    [senderId, recipientId, outsiderId, otherId] = registrations.map(
      (result) => result.body.data.user.id as string,
    );
    await activeDatabase.update(users).set({ isPrivate: true }).where(eq(users.id, recipientId));
  });

  afterAll(async () => {
    if (database) {
      for (const account of Object.values(accounts)) {
        await database.delete(users).where(eq(users.email, account.email));
      }
    }
    await closeDatabase();
  });

  it('prevents self-messaging and validates initial message text and idempotency keys', async () => {
    const self = await mutate(
      sender,
      'post',
      `/api/conversations/${accounts.sender.username}`,
      messageInput('Hello myself'),
    );
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe('SELF_CONVERSATION');

    const blank = await mutate(
      sender,
      'post',
      `/api/conversations/${accounts.recipient.username}`,
      messageInput('   '),
    );
    expect(blank.status).toBe(400);
    const tooLong = await mutate(
      sender,
      'post',
      `/api/conversations/${accounts.recipient.username}`,
      messageInput('x'.repeat(2001)),
    );
    expect(tooLong.status).toBe(400);
    const invalidKey = await mutate(sender, 'post', `/api/conversations/${accounts.recipient.username}`, {
      text: 'Valid message',
      idempotencyKey: 'not-a-uuid',
    });
    expect(invalidKey.status).toBe(400);
  });

  it('creates one pending request even when the pair is opened repeatedly', async () => {
    initialMessageKey = randomUUID();
    const first = await mutate(
      sender,
      'post',
      `/api/conversations/${accounts.recipient.username}`,
      messageInput('  Initial request  ', initialMessageKey),
    );
    expect(first.status).toBe(201);
    expect(first.body.data.conversation).toMatchObject({
      requestStatus: 'pending',
      requestedByMe: true,
      created: true,
    });
    conversationId = first.body.data.conversation.id as string;

    const repeated = await mutate(
      sender,
      'post',
      `/api/conversations/${accounts.recipient.username}`,
      messageInput('A different ignored opening message'),
    );
    expect(repeated.status).toBe(200);
    expect(repeated.body.data.conversation).toMatchObject({
      id: conversationId,
      requestStatus: 'pending',
      requestedByMe: true,
      created: false,
    });
    const pairs = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(conversations)
      .where(
        and(
          eq(conversations.participantLowId, [senderId, recipientId].sort()[0]),
          eq(conversations.participantHighId, [senderId, recipientId].sort()[1]),
        ),
      );
    expect(pairs[0].count).toBe(1);
    const initialMessages = await db()
      .select({ id: messages.id, text: messages.text })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(initialMessages).toHaveLength(1);
    expect(initialMessages[0].text).toBe('Initial request');

    const reusedKey = await mutate(
      sender,
      'post',
      `/api/conversations/${accounts.other.username}`,
      messageInput('Key collision', initialMessageKey),
    );
    expect(reusedKey.status).toBe(409);
    const noOrphanConversation = await db()
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.participantLowId, [senderId, otherId].sort()[0]),
          eq(conversations.participantHighId, [senderId, otherId].sort()[1]),
        ),
      );
    expect(noOrphanConversation).toHaveLength(0);
  });

  it('requires recipient consent and hides conversation resources from nonparticipants', async () => {
    const guest = await request(app).get('/api/conversations');
    expect(guest.status).toBe(401);

    const inbox = await recipient.get('/api/conversations');
    expect(inbox.status).toBe(200);
    const requestSummary = inbox.body.data.conversations.find(
      (item: { id: string }) => item.id === conversationId,
    );
    expect(requestSummary).toMatchObject({
      username: accounts.sender.username,
      requestStatus: 'pending',
      requestedByMe: false,
      unreadCount: 1,
    });

    const unauthorizedRead = await outsider.get(`/api/conversations/${conversationId}/messages`);
    expect(unauthorizedRead.status).toBe(404);
    const unauthorizedMarkRead = await mutate(
      outsider,
      'put',
      `/api/conversations/${conversationId}/read`,
    );
    expect(unauthorizedMarkRead.status).toBe(404);
    const unauthorizedSend = await mutate(
      outsider,
      'post',
      `/api/conversations/${conversationId}/messages`,
      messageInput('Intrusion'),
    );
    expect(unauthorizedSend.status).toBe(404);
    const deniedPendingReply = await mutate(
      recipient,
      'post',
      `/api/conversations/${conversationId}/messages`,
      messageInput('Reply before accept'),
    );
    expect(deniedPendingReply.status).toBe(409);

    const senderCannotAccept = await mutate(
      sender,
      'put',
      `/api/conversations/${conversationId}/accept`,
    );
    expect(senderCannotAccept.status).toBe(404);
    const accepted = await mutate(
      recipient,
      'put',
      `/api/conversations/${conversationId}/accept`,
    );
    expect(accepted.status).toBe(200);
    const repeatedAccept = await mutate(
      recipient,
      'put',
      `/api/conversations/${conversationId}/accept`,
    );
    expect(repeatedAccept.body.data.requestStatus).toBe('accepted');

    const read = await mutate(recipient, 'put', `/api/conversations/${conversationId}/read`);
    expect(read.status).toBe(200);
    const readInbox = await recipient.get('/api/conversations');
    expect(
      readInbox.body.data.conversations.find((item: { id: string }) => item.id === conversationId)
        .unreadCount,
    ).toBe(0);
  });

  it('trims, deduplicates, paginates messages, and reports unread state', async () => {
    const initialPage = await sender.get(`/api/conversations/${conversationId}/messages?limit=2`);
    expect(initialPage.status).toBe(200);
    expect(initialPage.body.data.messages[0]).toMatchObject({
      text: 'Initial request',
      senderId,
      senderUsername: accounts.sender.username,
    });

    const blank = await mutate(
      recipient,
      'post',
      `/api/conversations/${conversationId}/messages`,
      messageInput(' '),
    );
    expect(blank.status).toBe(400);
    const tooLong = await mutate(
      recipient,
      'post',
      `/api/conversations/${conversationId}/messages`,
      messageInput('x'.repeat(2001)),
    );
    expect(tooLong.status).toBe(400);

    const key = randomUUID();
    const first = await mutate(
      recipient,
      'post',
      `/api/conversations/${conversationId}/messages`,
      messageInput('  Accepted reply  ', key),
    );
    const duplicate = await mutate(
      recipient,
      'post',
      `/api/conversations/${conversationId}/messages`,
      messageInput('Accepted reply', key),
    );
    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(201);
    expect(duplicate.body.data.message.id).toBe(first.body.data.message.id);
    expect(first.body.data.message.text).toBe('Accepted reply');
    const changedRetry = await mutate(
      recipient,
      'post',
      `/api/conversations/${conversationId}/messages`,
      messageInput('Different reply', key),
    );
    expect(changedRetry.status).toBe(409);

    for (let index = 0; index < 3; index += 1) {
      await mutate(
        sender,
        'post',
        `/api/conversations/${conversationId}/messages`,
        messageInput(`Older page ${index}`),
      );
    }
    const pageOne = await sender.get(`/api/conversations/${conversationId}/messages?limit=2`);
    expect(pageOne.body.data.messages).toHaveLength(2);
    expect(pageOne.body.data.nextCursor).toEqual(expect.any(String));
    const pageTwo = await sender.get(
      `/api/conversations/${conversationId}/messages?limit=2&cursor=${encodeURIComponent(pageOne.body.data.nextCursor)}`,
    );
    expect(pageTwo.status).toBe(200);
    expect(pageTwo.body.data.messages).toHaveLength(2);
    const allIds = [...pageOne.body.data.messages, ...pageTwo.body.data.messages].map(
      (message: { id: string }) => message.id,
    );
    expect(new Set(allIds).size).toBe(allIds.length);
    const invalidCursor = await sender.get(`/api/conversations/${conversationId}/messages?cursor=bad`);
    expect(invalidCursor.status).toBe(400);
    expect(invalidCursor.body.error.code).toBe('INVALID_CURSOR');

    const recipientInbox = await recipient.get('/api/conversations');
    const recipientSummary = recipientInbox.body.data.conversations.find(
      (item: { id: string }) => item.id === conversationId,
    );
    expect(recipientSummary.unreadCount).toBeGreaterThan(0);
    await mutate(recipient, 'put', `/api/conversations/${conversationId}/read`);
    const refreshedInbox = await recipient.get('/api/conversations');
    expect(
      refreshedInbox.body.data.conversations.find((item: { id: string }) => item.id === conversationId)
        .unreadCount,
    ).toBe(0);
  });

  it('lets the recipient decline a request and does not allow further messages', async () => {
    const created = await mutate(
      other,
      'post',
      `/api/conversations/${accounts.outsider.username}`,
      messageInput('Please accept this request'),
    );
    expect(created.status).toBe(201);
    const declinedId = created.body.data.conversation.id as string;
    const declined = await mutate(other, 'put', `/api/conversations/${declinedId}/decline`);
    expect(declined.status).toBe(404);
    const recipientDeclined = await mutate(
      outsider,
      'put',
      `/api/conversations/${declinedId}/decline`,
    );
    expect(recipientDeclined.body.data.requestStatus).toBe('declined');
    const blocked = await mutate(
      other,
      'post',
      `/api/conversations/${declinedId}/messages`,
      messageInput('Follow-up after decline'),
    );
    expect(blocked.status).toBe(409);
    const participants = await db()
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, declinedId));
    expect(participants).toHaveLength(2);
  });

  it('paginates the inbox using a stable conversation cursor', async () => {
    const started = await mutate(
      other,
      'post',
      `/api/conversations/${accounts.sender.username}`,
      messageInput('Second inbox request'),
    );
    expect(started.status).toBe(201);
    const firstPage = await sender.get('/api/conversations?limit=1');
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data.conversations).toHaveLength(1);
    expect(firstPage.body.data.nextCursor).toEqual(expect.any(String));
    const secondPage = await sender.get(
      `/api/conversations?limit=1&cursor=${encodeURIComponent(firstPage.body.data.nextCursor)}`,
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data.conversations).toHaveLength(1);
    expect(secondPage.body.data.conversations[0].id).not.toBe(
      firstPage.body.data.conversations[0].id,
    );
    const invalidCursor = await sender.get('/api/conversations?cursor=bad');
    expect(invalidCursor.status).toBe(400);
    expect(invalidCursor.body.error.code).toBe('INVALID_CURSOR');
  });
});
