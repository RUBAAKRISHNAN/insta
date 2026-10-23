import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  conversationsResponseSchema,
  directMessageSchema,
  directMessagesResponseSchema,
  usernameSchema,
} from '@lumen/shared';
import { getDb } from '../db/client.js';
import {
  conversationParticipants,
  conversations,
  messages,
  sessions,
  users,
} from '../db/schema/index.js';

const router = Router();
const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});
const messageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
const messageTextSchema = z.string().trim().min(1).max(2000);
const messageInputSchema = z
  .object({ text: messageTextSchema, idempotencyKey: z.string().uuid() })
  .strict();
const pageSizeSchema = z.coerce.number().int().min(1).max(50);
const uuidSchema = z.string().uuid();
const conversationCursorSchema = z
  .object({ lastMessageAt: z.string().datetime({ offset: true }), id: z.string().uuid() })
  .strict();
const messageCursorSchema = z
  .object({ createdAt: z.string().datetime({ offset: true }), id: z.string().uuid() })
  .strict();
const defaultPageSize = 20;

class IdempotencyKeyConflict extends Error {}

type Database = NonNullable<ReturnType<typeof getDb>>;
type ConversationRow = {
  id: string;
  participantLowId: string;
  participantHighId: string;
  requestedById: string;
  requestStatus: string;
};

function sendError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

function encodeCursor<T>(value: T) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor<T>(value: unknown, schema: z.ZodType<T>): T | undefined {
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) return undefined;
    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    const result = schema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

async function currentUserId(req: Request): Promise<string | undefined> {
  const token = req.cookies?.lumen_session;
  const db = getDb();
  if (!token || !db) return undefined;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const [user] = await db
    .select({ id: users.id })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return user?.id;
}

async function getParticipantConversation(
  db: Database,
  conversationId: string,
  userId: string,
): Promise<ConversationRow | undefined> {
  const [conversation] = await db
    .select({
      id: conversations.id,
      participantLowId: conversations.participantLowId,
      participantHighId: conversations.participantHighId,
      requestedById: conversations.requestedById,
      requestStatus: conversations.requestStatus,
    })
    .from(conversations)
    .innerJoin(
      conversationParticipants,
      and(
        eq(conversationParticipants.conversationId, conversations.id),
        eq(conversationParticipants.userId, userId),
      ),
    )
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return conversation;
}

function respondToConversation(
  res: Response,
  conversation: ConversationRow,
  userId: string,
  status: number,
  created: boolean,
) {
  res.status(status).json({
    data: {
      conversation: {
        id: conversation.id,
        requestStatus: conversation.requestStatus,
        requestedByMe: conversation.requestedById === userId,
        created,
      },
    },
  });
}

router.get('/', (req, res, next) => {
  void (async () => {
    const db = getDb();
    if (!db) {
      sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
      return;
    }
    const userId = await currentUserId(req);
    if (!userId) {
      sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
      return;
    }
    let limit = defaultPageSize;
    if (req.query.limit !== undefined) {
      const parsedLimit = pageSizeSchema.safeParse(req.query.limit);
      if (!parsedLimit.success) {
        sendError(res, 400, 'VALIDATION_ERROR', 'Page size must be between 1 and 50.');
        return;
      }
      limit = parsedLimit.data;
    }
    const cursor =
      req.query.cursor === undefined
        ? undefined
        : decodeCursor(req.query.cursor, conversationCursorSchema);
    if (req.query.cursor !== undefined && !cursor) {
      sendError(res, 400, 'INVALID_CURSOR', 'The conversation cursor is invalid.');
      return;
    }
    const cursorFilter = cursor
      ? or(
          sql`${conversations.lastMessageAt} < ${cursor.lastMessageAt}::timestamptz`,
          and(
            sql`${conversations.lastMessageAt} = ${cursor.lastMessageAt}::timestamptz`,
            lt(conversations.id, cursor.id),
          ),
        )
      : undefined;
    const rows = await db
      .select({
        id: conversations.id,
        requestStatus: conversations.requestStatus,
        requestedById: conversations.requestedById,
        lastMessageAt: sql<string>`to_char(${conversations.lastMessageAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        username: sql<string>`(
          select ${users.username} from ${users}
          where ${users.id} = case
            when ${conversations.participantLowId} = ${userId}
            then ${conversations.participantHighId}
            else ${conversations.participantLowId}
          end
        )`,
        displayName: sql<string>`(
          select ${users.displayName} from ${users}
          where ${users.id} = case
            when ${conversations.participantLowId} = ${userId}
            then ${conversations.participantHighId}
            else ${conversations.participantLowId}
          end
        )`,
        avatarUrl: sql<string | null>`(
          select ${users.avatarUrl} from ${users}
          where ${users.id} = case
            when ${conversations.participantLowId} = ${userId}
            then ${conversations.participantHighId}
            else ${conversations.participantLowId}
          end
        )`,
        unreadCount: sql<number>`(
          select count(*)::int from ${messages}
          where ${messages.conversationId} = ${conversations.id}
            and ${messages.senderId} <> ${userId}
            and ${messages.createdAt} > coalesce(
              ${conversationParticipants.lastReadAt},
              '-infinity'::timestamptz
            )
        )`,
      })
      .from(conversations)
      .innerJoin(
        conversationParticipants,
        and(
          eq(conversationParticipants.conversationId, conversations.id),
          eq(conversationParticipants.userId, userId),
        ),
      )
      .where(cursorFilter)
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const response = conversationsResponseSchema.parse({
      conversations: page.map((conversation) => ({
        id: conversation.id,
        username: conversation.username,
        displayName: conversation.displayName,
        avatarUrl: conversation.avatarUrl,
        requestStatus: conversation.requestStatus,
        requestedByMe: conversation.requestedById === userId,
        lastMessageAt: conversation.lastMessageAt,
        unreadCount: conversation.unreadCount,
      })),
      nextCursor:
        hasMore && page.length > 0
          ? encodeCursor({
              lastMessageAt: page[page.length - 1].lastMessageAt,
              id: page[page.length - 1].id,
            })
          : null,
    });
    res.json({ data: response });
  })().catch(next);
});

/** Conversations with unread messages or an incoming request, for the inbox badge. */
router.get('/unread-count', (req, res, next) => {
  void (async () => {
    const db = getDb();
    if (!db) {
      sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
      return;
    }
    const userId = await currentUserId(req);
    if (!userId) {
      sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
      return;
    }
    const [row] = await db
      .select({
        unreadConversations: sql<number>`count(*)::int`,
        requests: sql<number>`count(*) filter (
          where ${conversations.requestStatus} = 'pending'
            and ${conversations.requestedById} <> ${userId}
        )::int`,
      })
      .from(conversations)
      .innerJoin(
        conversationParticipants,
        and(
          eq(conversationParticipants.conversationId, conversations.id),
          eq(conversationParticipants.userId, userId),
        ),
      )
      .where(
        or(
          and(
            eq(conversations.requestStatus, 'pending'),
            sql`${conversations.requestedById} <> ${userId}`,
          ),
          sql`exists (
            select 1 from ${messages}
            where ${messages.conversationId} = ${conversations.id}
              and ${messages.senderId} <> ${userId}
              and ${messages.createdAt} > coalesce(
                ${conversationParticipants.lastReadAt},
                '-infinity'::timestamptz
              )
          )`,
        ),
      );
    res.json({
      data: { unreadConversations: row?.unreadConversations ?? 0, requests: row?.requests ?? 0 },
    });
  })().catch(next);
});

router.post('/:username', createLimiter, (req, res, next) => {
  void (async () => {
    const db = getDb();
    if (!db) {
      sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
      return;
    }
    const userId = await currentUserId(req);
    if (!userId) {
      sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
      return;
    }
    const parsedUsername = usernameSchema.safeParse(req.params.username);
    const input = messageInputSchema.safeParse(req.body);
    if (!parsedUsername.success || !input.success) {
      sendError(res, 400, 'VALIDATION_ERROR', 'Provide a username and a message of 1 to 2000 characters.');
      return;
    }
    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, parsedUsername.data.toLowerCase()))
      .limit(1);
    if (!target) {
      sendError(res, 404, 'NOT_FOUND', 'User not found.');
      return;
    }
    if (target.id === userId) {
      sendError(res, 400, 'SELF_CONVERSATION', 'You cannot message yourself.');
      return;
    }
    const [participantLowId, participantHighId] = [userId, target.id].sort();
    let result:
      | { conversation: ConversationRow; created: boolean }
      | { keyConflict: true }
      | undefined;
    try {
      result = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(conversations)
        .values({
          participantLowId,
          participantHighId,
          requestedById: userId,
          requestStatus: 'pending',
        })
        .onConflictDoNothing({
          target: [conversations.participantLowId, conversations.participantHighId],
        })
        .returning({
          id: conversations.id,
          participantLowId: conversations.participantLowId,
          participantHighId: conversations.participantHighId,
          requestedById: conversations.requestedById,
          requestStatus: conversations.requestStatus,
        });
      if (!created) {
        const [existing] = await tx
          .select({
            id: conversations.id,
            participantLowId: conversations.participantLowId,
            participantHighId: conversations.participantHighId,
            requestedById: conversations.requestedById,
            requestStatus: conversations.requestStatus,
          })
          .from(conversations)
          .where(
            and(
              eq(conversations.participantLowId, participantLowId),
              eq(conversations.participantHighId, participantHighId),
            ),
          )
          .limit(1);
        return existing ? { conversation: existing, created: false } : undefined;
      }
      // Only the sender has read the opening message; it stays unread for the recipient.
      await tx.insert(conversationParticipants).values([
        { conversationId: created.id, userId: participantLowId },
        { conversationId: created.id, userId: participantHighId },
      ]);
      const [firstMessage] = await tx
        .insert(messages)
        .values({
          conversationId: created.id,
          senderId: userId,
          text: input.data.text,
          idempotencyKey: input.data.idempotencyKey,
        })
        .onConflictDoNothing()
        .returning({ id: messages.id });
      if (!firstMessage) throw new IdempotencyKeyConflict();
      const now = new Date();
      await tx
        .update(conversations)
        .set({ lastMessageAt: now, updatedAt: now })
        .where(eq(conversations.id, created.id));
      await tx
        .update(conversationParticipants)
        .set({ lastReadAt: now })
        .where(
          and(
            eq(conversationParticipants.conversationId, created.id),
            eq(conversationParticipants.userId, userId),
          ),
        );
      return { conversation: created, created: true };
      });
    } catch (error) {
      if (error instanceof IdempotencyKeyConflict) {
        sendError(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'This message key was already used.');
        return;
      }
      throw error;
    }
    if (!result) {
      sendError(res, 409, 'CONVERSATION_CONFLICT', 'Unable to open this conversation. Try again.');
      return;
    }
    respondToConversation(
      res,
      result.conversation,
      userId,
      result.created ? 201 : 200,
      result.created,
    );
  })().catch(next);
});

router.get('/:conversationId/messages', (req, res, next) => {
  void (async () => {
    const db = getDb();
    if (!db) {
      sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
      return;
    }
    const userId = await currentUserId(req);
    if (!userId) {
      sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
      return;
    }
    const conversationId = uuidSchema.safeParse(req.params.conversationId);
    if (!conversationId.success) {
      sendError(res, 404, 'NOT_FOUND', 'Conversation not found.');
      return;
    }
    const conversation = await getParticipantConversation(db, conversationId.data, userId);
    if (!conversation) {
      sendError(res, 404, 'NOT_FOUND', 'Conversation not found.');
      return;
    }
    let limit = defaultPageSize;
    if (req.query.limit !== undefined) {
      const parsedLimit = pageSizeSchema.safeParse(req.query.limit);
      if (!parsedLimit.success) {
        sendError(res, 400, 'VALIDATION_ERROR', 'Page size must be between 1 and 50.');
        return;
      }
      limit = parsedLimit.data;
    }
    const cursor =
      req.query.cursor === undefined
        ? undefined
        : decodeCursor(req.query.cursor, messageCursorSchema);
    if (req.query.cursor !== undefined && !cursor) {
      sendError(res, 400, 'INVALID_CURSOR', 'The message cursor is invalid.');
      return;
    }
    const cursorFilter = cursor
      ? or(
          sql`${messages.createdAt} < ${cursor.createdAt}::timestamptz`,
          and(
            sql`${messages.createdAt} = ${cursor.createdAt}::timestamptz`,
            lt(messages.id, cursor.id),
          ),
        )
      : undefined;
    const rows = await db
      .select({
        id: messages.id,
        senderId: messages.senderId,
        senderUsername: users.username,
        text: messages.text,
        createdAt: sql<string>`to_char(${messages.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(messages)
      .innerJoin(users, eq(messages.senderId, users.id))
      .where(
        cursorFilter
          ? and(eq(messages.conversationId, conversation.id), cursorFilter)
          : eq(messages.conversationId, conversation.id),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const response = directMessagesResponseSchema.parse({
      messages: page,
      nextCursor:
        hasMore && page.length > 0
          ? encodeCursor({
              createdAt: page[page.length - 1].createdAt,
              id: page[page.length - 1].id,
            })
          : null,
    });
    res.json({ data: response });
  })().catch(next);
});

router.post('/:conversationId/messages', messageLimiter, (req, res, next) => {
  void (async () => {
    const db = getDb();
    if (!db) {
      sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
      return;
    }
    const userId = await currentUserId(req);
    if (!userId) {
      sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
      return;
    }
    const conversationId = uuidSchema.safeParse(req.params.conversationId);
    const input = messageInputSchema.safeParse(req.body);
    if (!conversationId.success) {
      sendError(res, 404, 'NOT_FOUND', 'Conversation not found.');
      return;
    }
    if (!input.success) {
      sendError(res, 400, 'VALIDATION_ERROR', 'Message must contain 1 to 2000 characters.');
      return;
    }
    const conversation = await getParticipantConversation(db, conversationId.data, userId);
    if (!conversation) {
      sendError(res, 404, 'NOT_FOUND', 'Conversation not found.');
      return;
    }
    if (conversation.requestStatus !== 'accepted') {
      sendError(res, 409, 'MESSAGE_REQUEST_PENDING', 'This message request has not been accepted.');
      return;
    }
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          senderId: messages.senderId,
          text: messages.text,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.senderId, userId),
            eq(messages.idempotencyKey, input.data.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        if (
          existing.conversationId !== conversation.id ||
          existing.text !== input.data.text
        ) {
          return { kind: 'key_conflict' as const };
        }
        return { kind: 'created' as const, message: existing };
      }
      const [created] = await tx
        .insert(messages)
        .values({
          conversationId: conversation.id,
          senderId: userId,
          text: input.data.text,
          idempotencyKey: input.data.idempotencyKey,
        })
        .onConflictDoNothing()
        .returning({
          id: messages.id,
          conversationId: messages.conversationId,
          senderId: messages.senderId,
          text: messages.text,
          createdAt: messages.createdAt,
        });
      if (!created) {
        const [raced] = await tx
          .select({
            id: messages.id,
            conversationId: messages.conversationId,
            senderId: messages.senderId,
            text: messages.text,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(
            and(
              eq(messages.senderId, userId),
              eq(messages.idempotencyKey, input.data.idempotencyKey),
            ),
          )
          .limit(1);
        if (
          !raced ||
          raced.conversationId !== conversation.id ||
          raced.text !== input.data.text
        ) {
          return { kind: 'key_conflict' as const };
        }
        return { kind: 'created' as const, message: raced };
      }
      const now = created.createdAt;
      await tx
        .update(conversations)
        .set({ lastMessageAt: now, updatedAt: now })
        .where(eq(conversations.id, conversation.id));
      await tx
        .update(conversationParticipants)
        .set({ lastReadAt: now })
        .where(
          and(
            eq(conversationParticipants.conversationId, conversation.id),
            eq(conversationParticipants.userId, userId),
          ),
        );
      return { kind: 'created' as const, message: created };
    });
    if (result.kind === 'key_conflict') {
      sendError(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'This message key was already used.');
      return;
    }
    const [sender] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const response = directMessageSchema.parse({
      id: result.message.id,
      senderId: result.message.senderId,
      senderUsername: sender.username,
      text: result.message.text,
      createdAt: result.message.createdAt.toISOString(),
    });
    res.status(201).json({ data: { message: response } });
  })().catch(next);
});

router.put('/:conversationId/read', (req, res, next) => {
  void (async () => {
    const db = getDb();
    if (!db) {
      sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
      return;
    }
    const userId = await currentUserId(req);
    if (!userId) {
      sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
      return;
    }
    const conversationId = uuidSchema.safeParse(req.params.conversationId);
    if (!conversationId.success) {
      sendError(res, 404, 'NOT_FOUND', 'Conversation not found.');
      return;
    }
    const [participant] = await db
      .update(conversationParticipants)
      .set({ lastReadAt: new Date() })
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId.data),
          eq(conversationParticipants.userId, userId),
        ),
      )
      .returning({ conversationId: conversationParticipants.conversationId });
    if (!participant) {
      sendError(res, 404, 'NOT_FOUND', 'Conversation not found.');
      return;
    }
    res.json({ data: { read: true } });
  })().catch(next);
});

router.put('/:conversationId/accept', (req, res, next) => {
  void (async () => {
    const db = getDb();
    if (!db) {
      sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
      return;
    }
    const userId = await currentUserId(req);
    if (!userId) {
      sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
      return;
    }
    const conversationId = uuidSchema.safeParse(req.params.conversationId);
    if (!conversationId.success) {
      sendError(res, 404, 'NOT_FOUND', 'Conversation not found.');
      return;
    }
    const [updated] = await db
      .update(conversations)
      .set({ requestStatus: 'accepted', updatedAt: new Date() })
      .where(
        and(
          eq(conversations.id, conversationId.data),
          eq(conversations.requestStatus, 'pending'),
          sql`${conversations.requestedById} <> ${userId}`,
          sql`exists (
            select 1 from ${conversationParticipants}
            where ${conversationParticipants.conversationId} = ${conversations.id}
              and ${conversationParticipants.userId} = ${userId}
          )`,
        ),
      )
      .returning({ id: conversations.id });
    if (updated) {
      res.json({ data: { requestStatus: 'accepted' } });
      return;
    }
    const conversation = await getParticipantConversation(db, conversationId.data, userId);
    if (conversation?.requestStatus === 'accepted' && conversation.requestedById !== userId) {
      res.json({ data: { requestStatus: 'accepted' } });
      return;
    }
    sendError(res, 404, 'NOT_FOUND', 'Message request not found.');
  })().catch(next);
});

router.put('/:conversationId/decline', (req, res, next) => {
  void (async () => {
    const db = getDb();
    if (!db) {
      sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
      return;
    }
    const userId = await currentUserId(req);
    if (!userId) {
      sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
      return;
    }
    const conversationId = uuidSchema.safeParse(req.params.conversationId);
    if (!conversationId.success) {
      sendError(res, 404, 'NOT_FOUND', 'Conversation not found.');
      return;
    }
    const [updated] = await db
      .update(conversations)
      .set({ requestStatus: 'declined', updatedAt: new Date() })
      .where(
        and(
          eq(conversations.id, conversationId.data),
          eq(conversations.requestStatus, 'pending'),
          sql`${conversations.requestedById} <> ${userId}`,
          sql`exists (
            select 1 from ${conversationParticipants}
            where ${conversationParticipants.conversationId} = ${conversations.id}
              and ${conversationParticipants.userId} = ${userId}
          )`,
        ),
      )
      .returning({ id: conversations.id });
    if (updated) {
      res.json({ data: { requestStatus: 'declined' } });
      return;
    }
    const conversation = await getParticipantConversation(db, conversationId.data, userId);
    if (conversation?.requestStatus === 'declined' && conversation.requestedById !== userId) {
      res.json({ data: { requestStatus: 'declined' } });
      return;
    }
    sendError(res, 404, 'NOT_FOUND', 'Message request not found.');
  })().catch(next);
});

export { router as conversationsRouter };
