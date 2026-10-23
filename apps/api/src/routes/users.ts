import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { fileTypeFromBuffer } from 'file-type';
import multer from 'multer';
import { and, count, desc, eq, gt, ilike, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { postFeedResponseSchema, userDiscoveryResponseSchema, usernameSchema } from '@lumen/shared';
import { getDb } from '../db/client.js';
import { follows, notifications, posts, sessions, users } from '../db/schema/index.js';
import { imageStorage } from '../storage/image-storage.js';
import { visibleAccount } from './visibility.js';

const router = Router();
const discoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
const followLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
});
const avatarLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
const maxAvatarBytes = 8 * 1024 * 1024;
const avatarTypes = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;
const avatarContentTypes: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};
const avatarPathPrefix = '/users/avatars/';
const avatarKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/;
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxAvatarBytes, files: 1, fields: 0, parts: 1 },
});
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const profileInput = z
  .object({
    username: usernameSchema.optional(),
    displayName: z.string().trim().min(1).max(80).optional(),
    bio: z.string().max(500).nullable().optional(),
    avatarUrl: z.string().url().max(2048).nullable().optional(),
    isPrivate: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0);
const cursorSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();
const limitSchema = z.coerce.number().int().min(1).max(50);
const discoveryLimitSchema = z.coerce.number().int().min(1).max(30);
const uuidSchema = z.string().uuid();
const pageSize = 20;
const discoveryQuerySchema = z
  .string()
  .trim()
  .min(2)
  .max(30)
  .regex(/^[a-zA-Z0-9._]+$/);
const discoveryCursorSchema = z
  .object({ query: discoveryQuerySchema, username: usernameSchema, id: z.string().uuid() })
  .strict();

type CurrentUser = {
  id: string;
  email: string;
  username: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  isPrivate: boolean;
};

async function current(token: string | undefined): Promise<CurrentUser | undefined> {
  const db = getDb();
  if (!db || !token) return undefined;
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
      displayName: users.displayName,
      bio: users.bio,
      avatarUrl: users.avatarUrl,
      isPrivate: users.isPrivate,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, hash(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return user;
}

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

function encodeDiscoveryCursor(value: z.infer<typeof discoveryCursorSchema>) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeDiscoveryCursor(value: unknown) {
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) return undefined;
    const result = discoveryCursorSchema.safeParse(JSON.parse(decoded.toString('utf8')));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

async function acceptedCounts(userId: string) {
  const db = getDb();
  if (!db) throw new Error('Database unavailable.');
  const [followers, following] = await Promise.all([
    db
      .select({ value: count() })
      .from(follows)
      .where(and(eq(follows.followedId, userId), eq(follows.status, 'accepted'))),
    db
      .select({ value: count() })
      .from(follows)
      .where(and(eq(follows.followerId, userId), eq(follows.status, 'accepted'))),
  ]);
  return { followerCount: followers[0].value, followingCount: following[0].value };
}

router.get('/discover', discoveryLimiter, async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
    const viewer = await current(req.cookies?.lumen_session);
    if (!viewer) return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
    if (typeof req.query.q !== 'string') {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Search must be 2 to 30 username characters.');
    }
    const parsedQuery = discoveryQuerySchema.safeParse(req.query.q);
    if (!parsedQuery.success) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Search must be 2 to 30 username characters.');
    }
    let limit = pageSize;
    if (req.query.limit !== undefined) {
      const parsedLimit = discoveryLimitSchema.safeParse(req.query.limit);
      if (!parsedLimit.success) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Page size must be between 1 and 30.');
      }
      limit = parsedLimit.data;
    }
    const cursor =
      req.query.cursor === undefined ? undefined : decodeDiscoveryCursor(req.query.cursor);
    if (
      req.query.cursor !== undefined &&
      (!cursor || cursor.query.toLowerCase() !== parsedQuery.data.toLowerCase())
    ) {
      return sendError(res, 400, 'INVALID_CURSOR', 'The search cursor is invalid.');
    }

    const normalizedQuery = parsedQuery.data.toLowerCase();
    const escapedQuery = normalizedQuery.replace(/[\\%_]/g, '\\$&');
    const cursorFilter = cursor
      ? or(
          sql`${users.username} > ${cursor.username}`,
          and(eq(users.username, cursor.username), sql`${users.id} > ${cursor.id}`),
        )
      : undefined;
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        isPrivate: users.isPrivate,
        followState: sql<'none' | 'pending' | 'following'>`coalesce((
          select case when ${follows.status} = 'accepted' then 'following' else 'pending' end
          from ${follows}
          where ${follows.followerId} = ${viewer.id} and ${follows.followedId} = ${users.id}
        ), 'none')`,
      })
      .from(users)
      .where(
        and(
          ilike(users.username, `${escapedQuery}%`),
          sql`${users.id} <> ${viewer.id}`,
          cursorFilter,
        ),
      )
      .orderBy(users.username, users.id)
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const visible = page.map((profile) =>
      !profile.isPrivate || profile.followState === 'following'
        ? {
            username: profile.username,
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
            isPrivate: profile.isPrivate,
            followState: profile.followState,
          }
        : {
            username: profile.username,
            isPrivate: true,
            followState: profile.followState,
          },
    );
    const response = userDiscoveryResponseSchema.parse({
      users: visible,
      nextCursor:
        hasMore && page.length
          ? encodeDiscoveryCursor({
              query: normalizedQuery,
              username: page[page.length - 1].username,
              id: page[page.length - 1].id,
            })
          : null,
    });
    res.json({ data: response });
  } catch (error) {
    next(error);
  }
});

router.get('/me/follow-requests', followLimiter, async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
    const viewer = await current(req.cookies?.lumen_session);
    if (!viewer) return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
    const requests = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        createdAt: follows.createdAt,
      })
      .from(follows)
      .innerJoin(users, eq(follows.followerId, users.id))
      .where(and(eq(follows.followedId, viewer.id), eq(follows.status, 'pending')))
      .orderBy(follows.createdAt, follows.followerId);
    res.json({
      data: {
        requests: requests.map((request) => ({
          ...request,
          createdAt: request.createdAt.toISOString(),
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.put('/follow-requests/:followerId/approve', followLimiter, async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
    const viewer = await current(req.cookies?.lumen_session);
    if (!viewer) return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
    const followerId = uuidSchema.safeParse(req.params.followerId);
    if (!followerId.success) {
      return sendError(res, 404, 'NOT_FOUND', 'Follow request not found.');
    }
    const approved = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(follows)
        .set({ status: 'accepted', updatedAt: new Date() })
        .where(
          and(
            eq(follows.followedId, viewer.id),
            eq(follows.followerId, followerId.data),
            eq(follows.status, 'pending'),
          ),
        )
        .returning({ followerId: follows.followerId });
      if (row) {
        await tx.insert(notifications).values({
          recipientId: row.followerId,
          actorId: viewer.id,
          type: 'follow_approved',
          relatedUserId: viewer.id,
        });
      }
      return row;
    });
    if (!approved) return sendError(res, 404, 'NOT_FOUND', 'Follow request not found.');
    res.json({ data: { status: 'accepted' } });
  } catch (error) {
    next(error);
  }
});

router.delete('/follow-requests/:followerId', followLimiter, async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
    const viewer = await current(req.cookies?.lumen_session);
    if (!viewer) return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
    const followerId = uuidSchema.safeParse(req.params.followerId);
    if (!followerId.success) {
      return sendError(res, 404, 'NOT_FOUND', 'Follow request not found.');
    }
    await db
      .delete(follows)
      .where(
        and(
          eq(follows.followedId, viewer.id),
          eq(follows.followerId, followerId.data),
          eq(follows.status, 'pending'),
        ),
      );
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.put('/:username/follow', followLimiter, async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
    const viewer = await current(req.cookies?.lumen_session);
    if (!viewer) return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
    const parsedUsername = usernameSchema.safeParse(req.params.username);
    if (!parsedUsername.success) return sendError(res, 404, 'NOT_FOUND', 'Profile not found.');
    const username = parsedUsername.data.toLowerCase();

    const result = await db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: users.id, isPrivate: users.isPrivate })
        .from(users)
        .where(eq(users.username, username))
        .for('update')
        .limit(1);
      if (!target) return { kind: 'missing' as const };
      if (target.id === viewer.id) return { kind: 'self' as const };
      const [existing] = await tx
        .select({ status: follows.status })
        .from(follows)
        .where(and(eq(follows.followerId, viewer.id), eq(follows.followedId, target.id)))
        .limit(1);
      const status =
        existing?.status === 'accepted' || !target.isPrivate ? 'accepted' : 'pending';
      await tx
        .insert(follows)
        .values({ followerId: viewer.id, followedId: target.id, status })
        .onConflictDoUpdate({
          target: [follows.followerId, follows.followedId],
          set: { status, updatedAt: new Date() },
        });
      if (existing?.status !== status) {
        await tx.insert(notifications).values({
          recipientId: target.id,
          actorId: viewer.id,
          type: status === 'accepted' ? 'follow' : 'follow_request',
          relatedUserId: target.id,
        });
      }
      return { kind: 'ok' as const, status };
    });
    if (result.kind === 'missing') return sendError(res, 404, 'NOT_FOUND', 'Profile not found.');
    if (result.kind === 'self') return sendError(res, 400, 'SELF_FOLLOW', 'You cannot follow yourself.');
    res.json({ data: { followState: result.status === 'accepted' ? 'following' : 'pending' } });
  } catch (error) {
    next(error);
  }
});

router.delete('/:username/follow', followLimiter, async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
    const viewer = await current(req.cookies?.lumen_session);
    if (!viewer) return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
    const parsedUsername = usernameSchema.safeParse(req.params.username);
    if (!parsedUsername.success) return sendError(res, 404, 'NOT_FOUND', 'Profile not found.');
    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, parsedUsername.data.toLowerCase()))
      .limit(1);
    if (!target) return sendError(res, 404, 'NOT_FOUND', 'Profile not found.');
    if (target.id === viewer.id) return sendError(res, 400, 'SELF_FOLLOW', 'You cannot follow yourself.');
    await db
      .delete(follows)
      .where(and(eq(follows.followerId, viewer.id), eq(follows.followedId, target.id)));
    res.json({ data: { followState: 'none' } });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
    const viewer = await current(req.cookies?.lumen_session);
    if (!viewer) return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
    const parsedUsername = usernameSchema.safeParse(String(req.query.username ?? '').trim());
    if (!parsedUsername.success) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'A valid username is required.');
    }
    const [target] = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        bio: users.bio,
        avatarUrl: users.avatarUrl,
        isPrivate: users.isPrivate,
      })
      .from(users)
      .where(eq(users.username, parsedUsername.data.toLowerCase()))
      .limit(1);
    if (!target) return sendError(res, 404, 'NOT_FOUND', 'Profile not found.');
    let followState: 'none' | 'pending' | 'following' = 'none';
    if (viewer.id !== target.id) {
      const [relationship] = await db
        .select({ status: follows.status })
        .from(follows)
        .where(and(eq(follows.followerId, viewer.id), eq(follows.followedId, target.id)))
        .limit(1);
      if (relationship?.status === 'accepted') followState = 'following';
      if (relationship?.status === 'pending') followState = 'pending';
    }
    const canViewDetails =
      !target.isPrivate || viewer?.id === target.id || followState === 'following';
    if (!canViewDetails) {
      return res.json({
        data: {
          user: {
            username: target.username,
            isPrivate: true,
            followState,
            followerCount: null,
            followingCount: null,
          },
        },
      });
    }
    const counts = await acceptedCounts(target.id);
    res.json({ data: { user: { ...target, ...counts, followState } } });
  } catch (error) {
    next(error);
  }
});

router.get('/:username/posts', async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
    const viewer = await current(req.cookies?.lumen_session);
    if (!viewer) return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
    const parsedUsername = usernameSchema.safeParse(req.params.username);
    if (!parsedUsername.success) return sendError(res, 404, 'NOT_FOUND', 'Profile not found.');
    const [author] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, parsedUsername.data.toLowerCase()))
      .limit(1);
    if (!author) return sendError(res, 404, 'NOT_FOUND', 'Profile not found.');

    let limit = pageSize;
    if (req.query.limit !== undefined) {
      const parsedLimit = limitSchema.safeParse(req.query.limit);
      if (!parsedLimit.success) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Page size must be between 1 and 50.');
      }
      limit = parsedLimit.data;
    }
    const cursor =
      req.query.cursor === undefined ? undefined : decodeCursor(req.query.cursor);
    if (req.query.cursor !== undefined && !cursor) {
      return sendError(res, 400, 'INVALID_CURSOR', 'The post cursor is invalid.');
    }
    const cursorFilter = cursor
      ? or(
          sql`${posts.createdAt} < ${cursor.createdAt}::timestamptz`,
          and(
            sql`${posts.createdAt} = ${cursor.createdAt}::timestamptz`,
            lt(posts.id, cursor.id),
          ),
        )
      : undefined;
    const conditions = and(
      eq(posts.userId, author.id),
      visibleAccount(viewer.id),
      ...(cursorFilter ? [cursorFilter] : []),
    );
    const rows = await db
      .select({
        id: posts.id,
        caption: posts.caption,
        createdAt: sql<string>`to_char(${posts.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        authorId: users.id,
        authorUsername: users.username,
        authorAvatarUrl: users.avatarUrl,
        likeCount: sql<number>`(select count(*)::int from post_likes where post_id = ${posts.id})`,
        likedByMe: sql<boolean>`exists (select 1 from post_likes where post_id = ${posts.id} and user_id = ${viewer.id})`,
        commentCount: sql<number>`(select count(*)::int from post_comments where post_id = ${posts.id})`,
      })
      .from(posts)
      .innerJoin(users, eq(posts.userId, users.id))
      .where(conditions)
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const response = postFeedResponseSchema.parse({
      posts: page.map((post) => ({ ...post, imageUrl: `/posts/${post.id}/image` })),
      nextCursor:
        hasMore && page.length
          ? encodeCursor({
              createdAt: page[page.length - 1].createdAt,
              id: page[page.length - 1].id,
            })
          : null,
    });
    res.json({ data: response });
  } catch (error) {
    next(error);
  }
});

/** Storage key of an avatar uploaded through this API, if the URL points at one. */
function uploadedAvatarKey(avatarUrl: string | null) {
  if (!avatarUrl?.startsWith(avatarPathPrefix)) return undefined;
  const key = avatarUrl.slice(avatarPathPrefix.length);
  return avatarKeyPattern.test(key) ? key : undefined;
}

async function removeStoredAvatar(avatarUrl: string | null) {
  const key = uploadedAvatarKey(avatarUrl);
  if (!key) return;
  try {
    await imageStorage.remove(key);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'avatar_cleanup_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    );
  }
}

function runAvatarUpload(req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    avatarUpload.single('image')(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          sendError(res, 413, 'UPLOAD_TOO_LARGE', 'Profile photos must be 8 MB or smaller.');
        } else {
          sendError(res, 400, 'INVALID_UPLOAD', 'Select one image.');
        }
        resolve();
        return;
      }
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

const profileColumns = {
  id: users.id,
  email: users.email,
  username: users.username,
  displayName: users.displayName,
  bio: users.bio,
  avatarUrl: users.avatarUrl,
  isPrivate: users.isPrivate,
};

router.get('/avatars/:key', async (req, res, next) => {
  try {
    const viewer = await current(req.cookies?.lumen_session);
    if (!viewer) return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
    const key = req.params.key;
    if (!avatarKeyPattern.test(key)) return sendError(res, 404, 'NOT_FOUND', 'Photo not found.');
    const image = await imageStorage.read(key);
    if (!image) return sendError(res, 404, 'NOT_FOUND', 'Photo not found.');
    const extension = key.slice(key.lastIndexOf('.') + 1);
    res
      .type(avatarContentTypes[extension])
      .set('X-Content-Type-Options', 'nosniff')
      .set('Cache-Control', 'private, max-age=31536000, immutable')
      .send(image);
  } catch (error) {
    next(error);
  }
});

router.post('/me/avatar', avatarLimiter, async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
    const viewer = await current(req.cookies?.lumen_session);
    if (!viewer) return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
    await runAvatarUpload(req, res);
    if (res.headersSent) return;
    if (!req.file) return sendError(res, 400, 'INVALID_UPLOAD', 'Choose a photo to upload.');

    const detected = await fileTypeFromBuffer(req.file.buffer);
    if (!detected || !Object.hasOwn(avatarTypes, detected.mime)) {
      return sendError(res, 415, 'INVALID_UPLOAD', 'Use a JPEG, PNG, or WebP image.');
    }
    const extension = avatarTypes[detected.mime as keyof typeof avatarTypes];
    const key = `${crypto.randomUUID()}.${extension}`;
    await imageStorage.put(key, req.file.buffer);

    let updatedUser;
    try {
      [updatedUser] = await db
        .update(users)
        .set({ avatarUrl: `${avatarPathPrefix}${key}`, updatedAt: new Date() })
        .where(eq(users.id, viewer.id))
        .returning(profileColumns);
    } catch (error) {
      await removeStoredAvatar(`${avatarPathPrefix}${key}`);
      throw error;
    }
    await removeStoredAvatar(viewer.avatarUrl);
    res.status(201).json({ data: { user: updatedUser } });
  } catch (error) {
    next(error);
  }
});

router.delete('/me/avatar', avatarLimiter, async (req, res, next) => {
  try {
    const db = getDb();
    if (!db) return sendError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
    const viewer = await current(req.cookies?.lumen_session);
    if (!viewer) return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
    const [updatedUser] = await db
      .update(users)
      .set({ avatarUrl: null, updatedAt: new Date() })
      .where(eq(users.id, viewer.id))
      .returning(profileColumns);
    await removeStoredAvatar(viewer.avatarUrl);
    res.json({ data: { user: updatedUser } });
  } catch (error) {
    next(error);
  }
});

router.patch('/me', async (req, res, next) => {
  try {
    const viewer = await current(req.cookies?.lumen_session);
    const db = getDb();
    if (!viewer || !db) return sendError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
    const values = profileInput.parse(req.body);
    if (values.username) values.username = values.username.trim().toLowerCase();
    const updatedUser = await db.transaction(async (tx) => {
      const [user] = await tx
        .update(users)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(users.id, viewer.id))
        .returning({
          id: users.id,
          email: users.email,
          username: users.username,
          displayName: users.displayName,
          bio: users.bio,
          avatarUrl: users.avatarUrl,
          isPrivate: users.isPrivate,
        });
      if (values.isPrivate === false) {
        await tx
          .update(follows)
          .set({ status: 'accepted', updatedAt: new Date() })
          .where(and(eq(follows.followedId, viewer.id), eq(follows.status, 'pending')));
      }
      return user;
    });
    res.json({ data: { user: updatedUser } });
  } catch (error) {
    next(error);
  }
});

export { router as usersRouter };
