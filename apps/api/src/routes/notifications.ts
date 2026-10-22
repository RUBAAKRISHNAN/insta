import crypto from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { notificationsResponseSchema } from '@lumen/shared';
import { getDb } from '../db/client.js';
import { notifications, posts, sessions, users } from '../db/schema/index.js';
import { visibleAccount } from './visibility.js';

const router = Router();
const pageSize = 20;
const limitSchema = z.coerce.number().int().min(1).max(50);
const cursorSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();
const notificationIdSchema = z.string().uuid();

function sendError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

function encodeCursor(value: z.infer<typeof cursorSchema>) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(value: unknown) {
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) return undefined;
    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    const result = cursorSchema.safeParse(parsed);
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

router.get('/', (req, res, next) => {
  void (async () => {
    const db = getDb();
    if (!db) {
      sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
      return;
    }
    const recipientId = await currentUserId(req);
    if (!recipientId) {
      sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
      return;
    }

    let limit = pageSize;
    if (req.query.limit !== undefined) {
      const parsedLimit = limitSchema.safeParse(req.query.limit);
      if (!parsedLimit.success) {
        sendError(res, 400, 'VALIDATION_ERROR', 'Page size must be between 1 and 50.');
        return;
      }
      limit = parsedLimit.data;
    }
    const cursor = req.query.cursor === undefined ? undefined : decodeCursor(req.query.cursor);
    if (req.query.cursor !== undefined && !cursor) {
      sendError(res, 400, 'INVALID_CURSOR', 'The notification cursor is invalid.');
      return;
    }
    const cursorFilter = cursor
      ? or(
          sql`${notifications.createdAt} < ${cursor.createdAt}::timestamptz`,
          and(
            sql`${notifications.createdAt} = ${cursor.createdAt}::timestamptz`,
            lt(notifications.id, cursor.id),
          ),
        )
      : undefined;
    const rows = await db
      .select({
        id: notifications.id,
        type: notifications.type,
        postId: notifications.postId,
        createdAt: sql<string>`to_char(${notifications.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        readAt: notifications.readAt,
        actorUsername: users.username,
        relatedUsername: sql<string | null>`(
          select ${users.username} from ${users}
          where ${users.id} = ${notifications.relatedUserId}
        )`,
      })
      .from(notifications)
      .innerJoin(users, eq(notifications.actorId, users.id))
      .where(
        cursorFilter
          ? and(eq(notifications.recipientId, recipientId), cursorFilter)
          : eq(notifications.recipientId, recipientId),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const postIds = [...new Set(page.flatMap((row) => (row.postId ? [row.postId] : [])))];
    const visiblePostIds = new Set<string>();
    if (postIds.length > 0) {
      const visiblePosts = await db
        .select({ id: posts.id })
        .from(posts)
        .innerJoin(users, eq(posts.userId, users.id))
        .where(and(inArray(posts.id, postIds), visibleAccount(recipientId)));
      for (const post of visiblePosts) visiblePostIds.add(post.id);
    }

    const response = notificationsResponseSchema.parse({
      notifications: page.map((notification) => {
        const canLinkPost =
          notification.postId !== null && visiblePostIds.has(notification.postId);
        return {
          id: notification.id,
          type: notification.type,
          actorUsername: notification.actorUsername,
          createdAt: notification.createdAt,
          readAt: notification.readAt?.toISOString() ?? null,
          postId: canLinkPost ? notification.postId : null,
          relatedUsername: notification.relatedUsername,
          resourceUrl: canLinkPost ? `/posts/${notification.postId}/image` : null,
        };
      }),
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

router.put('/:notificationId/read', (req, res, next) => {
  void (async () => {
    const db = getDb();
    if (!db) {
      sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
      return;
    }
    const recipientId = await currentUserId(req);
    if (!recipientId) {
      sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
      return;
    }
    const notificationId = notificationIdSchema.safeParse(req.params.notificationId);
    if (!notificationId.success) {
      sendError(res, 404, 'NOT_FOUND', 'Notification not found.');
      return;
    }
    const [updated] = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.id, notificationId.data),
          eq(notifications.recipientId, recipientId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ readAt: notifications.readAt });
    if (updated) {
      res.json({ data: { readAt: updated.readAt?.toISOString() ?? null } });
      return;
    }
    const [existing] = await db
      .select({ readAt: notifications.readAt })
      .from(notifications)
      .where(
        and(
          eq(notifications.id, notificationId.data),
          eq(notifications.recipientId, recipientId),
        ),
      )
      .limit(1);
    if (!existing) {
      sendError(res, 404, 'NOT_FOUND', 'Notification not found.');
      return;
    }
    res.json({ data: { readAt: existing.readAt?.toISOString() ?? null } });
  })().catch(next);
});

export { router as notificationsRouter };
