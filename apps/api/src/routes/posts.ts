import { createHash, randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { and, count, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import {
  postCaptionSchema,
  postCommentSchema,
  postCommentsResponseSchema,
  postFeedResponseSchema,
  postLikeStateSchema,
  postResponseSchema,
} from '@lumen/shared';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { notifications, postComments, postLikes, posts, sessions, users } from '../db/schema/index.js';
import { imageStorage, type ImageStorage } from '../storage/image-storage.js';
import { visibleAccount } from './visibility.js';

const maxImageBytes = 8 * 1024 * 1024;
const supportedImages = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;
type SupportedImageType = keyof typeof supportedImages;
type CurrentUser = {
  id: string;
  isPrivate: boolean;
  username: string;
  avatarUrl: string | null;
};
const cursorPayloadSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();
const pageSizeSchema = z.coerce.number().int().min(1).max(50);
const defaultPageSize = 20;
const commentTextSchema = z.string().trim().min(1).max(1000);
const postIdSchema = z.string().uuid();

function isSupportedImage(type: string): type is SupportedImageType {
  return Object.hasOwn(supportedImages, type);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxImageBytes, files: 1, fields: 1, parts: 2 },
});

async function currentUser(req: Request): Promise<CurrentUser | undefined> {
  const token = req.cookies?.lumen_session;
  const db = getDb();
  if (!token || !db) return undefined;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const [user] = await db
    .select({
      id: users.id,
      isPrivate: users.isPrivate,
      username: users.username,
      avatarUrl: users.avatarUrl,
    })
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
  return user;
}

function respondError(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

function runUpload(req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    upload.single('image')(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          respondError(res, 413, 'UPLOAD_TOO_LARGE', 'Image must be 8 MB or smaller.');
          resolve();
          return;
        }
        respondError(res, 400, 'INVALID_UPLOAD', 'Select one image and a caption.');
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

function keyFor(type: SupportedImageType) {
  return `${randomUUID()}.${supportedImages[type]}`;
}

function encodeCursor(cursor: z.infer<typeof cursorPayloadSchema>) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: unknown) {
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) return undefined;
    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    const result = cursorPayloadSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

async function visiblePost(postId: string, userId?: string) {
  const db = getDb();
  if (!db) return undefined;
  const [post] = await db
    .select({ id: posts.id, userId: posts.userId })
    .from(posts)
    .innerJoin(users, eq(posts.userId, users.id))
    .where(
      and(
        eq(posts.id, postId),
        userId ? visibleAccount(userId) : eq(users.isPrivate, false),
      ),
    )
    .limit(1);
  return post;
}

function validPostId(value: string) {
  return postIdSchema.safeParse(value).success;
}

export function createPostsRouter(storage: ImageStorage = imageStorage) {
  const router = Router();

  router.get('/', (req, res, next) => {
    void (async () => {
      const db = getDb();
      if (!db) {
        respondError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
        return;
      }
      const user = await currentUser(req);
      if (!user) {
        respondError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
        return;
      }

      const rawLimit = req.query.limit;
      let limit = defaultPageSize;
      if (rawLimit !== undefined) {
        const parsedLimit = pageSizeSchema.safeParse(rawLimit);
        if (!parsedLimit.success) {
          respondError(
            res,
            400,
            'VALIDATION_ERROR',
            'Page size must be an integer between 1 and 50.',
          );
          return;
        }
        limit = parsedLimit.data;
      }
      const rawCursor = req.query.cursor;
      const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor);
      if (rawCursor !== undefined && !cursor) {
        respondError(res, 400, 'INVALID_CURSOR', 'The feed cursor is invalid.');
        return;
      }

      const visibility = visibleAccount(user.id);
      const cursorFilter = cursor
        ? or(
            sql`${posts.createdAt} < ${cursor.createdAt}::timestamptz`,
            and(
              sql`${posts.createdAt} = ${cursor.createdAt}::timestamptz`,
              lt(posts.id, cursor.id),
            ),
          )
        : undefined;
      const conditions = cursorFilter ? and(visibility, cursorFilter) : visibility;
      const rows = await db
        .select({
          id: posts.id,
          caption: posts.caption,
          createdAt: sql<string>`to_char(${posts.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          authorId: users.id,
          authorUsername: users.username,
          authorAvatarUrl: users.avatarUrl,
          likeCount: sql<number>`(select count(*)::int from post_likes where post_id = ${posts.id})`,
          likedByMe: sql<boolean>`exists (select 1 from post_likes where post_id = ${posts.id} and user_id = ${user.id})`,
        })
        .from(posts)
        .innerJoin(users, eq(posts.userId, users.id))
        .where(conditions)
        .orderBy(desc(posts.createdAt), desc(posts.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const response = postFeedResponseSchema.parse({
        posts: page.map((post) => ({
          ...post,
          imageUrl: `/posts/${post.id}/image`,
        })),
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

  router.put('/:postId/like', (req, res, next) => {
    void (async () => {
      const db = getDb();
      if (!db) {
        respondError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
        return;
      }
      const user = await currentUser(req);
      if (!user) {
        respondError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
        return;
      }
      if (!validPostId(req.params.postId)) {
        respondError(res, 404, 'NOT_FOUND', 'Post not found.');
        return;
      }
      const post = await visiblePost(req.params.postId, user.id);
      if (!post) {
        respondError(res, 404, 'NOT_FOUND', 'Post not found.');
        return;
      }
      const state = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(postLikes)
          .values({ userId: user.id, postId: req.params.postId })
          .onConflictDoNothing({ target: [postLikes.userId, postLikes.postId] })
          .returning({ userId: postLikes.userId });
        if (inserted && post.userId !== user.id) {
          await tx.insert(notifications).values({
            recipientId: post.userId,
            actorId: user.id,
            type: 'like',
            postId: req.params.postId,
          });
        }
        const [result] = await tx
          .select({ likeCount: count() })
          .from(postLikes)
          .where(eq(postLikes.postId, req.params.postId));
        return { liked: true, likeCount: result.likeCount };
      });
      res.json({ data: postLikeStateSchema.parse(state) });
    })().catch(next);
  });

  router.delete('/:postId/like', (req, res, next) => {
    void (async () => {
      const db = getDb();
      if (!db) {
        respondError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
        return;
      }
      const user = await currentUser(req);
      if (!user) {
        respondError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
        return;
      }
      if (!validPostId(req.params.postId)) {
        respondError(res, 404, 'NOT_FOUND', 'Post not found.');
        return;
      }
      if (!(await visiblePost(req.params.postId, user.id))) {
        respondError(res, 404, 'NOT_FOUND', 'Post not found.');
        return;
      }
      const state = await db.transaction(async (tx) => {
        await tx
          .delete(postLikes)
          .where(and(eq(postLikes.userId, user.id), eq(postLikes.postId, req.params.postId)));
        const [result] = await tx
          .select({ likeCount: count() })
          .from(postLikes)
          .where(eq(postLikes.postId, req.params.postId));
        return { liked: false, likeCount: result.likeCount };
      });
      res.json({ data: postLikeStateSchema.parse(state) });
    })().catch(next);
  });

  router.get('/:postId/comments', (req, res, next) => {
    void (async () => {
      const db = getDb();
      if (!db) {
        respondError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
        return;
      }
      const user = await currentUser(req);
      if (!user) {
        respondError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
        return;
      }
      if (!validPostId(req.params.postId)) {
        respondError(res, 404, 'NOT_FOUND', 'Post not found.');
        return;
      }
      if (!(await visiblePost(req.params.postId, user.id))) {
        respondError(res, 404, 'NOT_FOUND', 'Post not found.');
        return;
      }
      let limit = defaultPageSize;
      if (req.query.limit !== undefined) {
        const parsedLimit = pageSizeSchema.safeParse(req.query.limit);
        if (!parsedLimit.success) {
          respondError(
            res,
            400,
            'VALIDATION_ERROR',
            'Page size must be an integer between 1 and 50.',
          );
          return;
        }
        limit = parsedLimit.data;
      }
      const cursor = req.query.cursor === undefined ? undefined : decodeCursor(req.query.cursor);
      if (req.query.cursor !== undefined && !cursor) {
        respondError(res, 400, 'INVALID_CURSOR', 'The comment cursor is invalid.');
        return;
      }
      const cursorFilter = cursor
        ? or(
            sql`${postComments.createdAt} < ${cursor.createdAt}::timestamptz`,
            and(
              sql`${postComments.createdAt} = ${cursor.createdAt}::timestamptz`,
              lt(postComments.id, cursor.id),
            ),
          )
        : undefined;
      const rows = await db
        .select({
          id: postComments.id,
          text: postComments.text,
          createdAt: sql<string>`to_char(${postComments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          authorId: users.id,
          authorUsername: users.username,
          authorAvatarUrl: users.avatarUrl,
        })
        .from(postComments)
        .innerJoin(users, eq(postComments.userId, users.id))
        .where(
          cursorFilter
            ? and(eq(postComments.postId, req.params.postId), cursorFilter)
            : eq(postComments.postId, req.params.postId),
        )
        .orderBy(desc(postComments.createdAt), desc(postComments.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const result = postCommentsResponseSchema.parse({
        comments: page,
        nextCursor:
          hasMore && page.length > 0
            ? encodeCursor({
                createdAt: page[page.length - 1].createdAt,
                id: page[page.length - 1].id,
              })
            : null,
      });
      res.json({ data: result });
    })().catch(next);
  });

  router.post('/:postId/comments', (req, res, next) => {
    void (async () => {
      const db = getDb();
      if (!db) {
        respondError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
        return;
      }
      const user = await currentUser(req);
      if (!user) {
        respondError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
        return;
      }
      if (!validPostId(req.params.postId)) {
        respondError(res, 404, 'NOT_FOUND', 'Post not found.');
        return;
      }
      const post = await visiblePost(req.params.postId, user.id);
      if (!post) {
        respondError(res, 404, 'NOT_FOUND', 'Post not found.');
        return;
      }
      const parsedText = commentTextSchema.safeParse(req.body?.text);
      if (!parsedText.success) {
        respondError(res, 400, 'VALIDATION_ERROR', 'Comment must contain 1 to 1000 characters.');
        return;
      }
      const idempotencyKeyHeader = req.get('idempotency-key');
      const idempotencyKey =
        idempotencyKeyHeader === undefined
          ? undefined
          : z.string().uuid().safeParse(idempotencyKeyHeader);
      if (idempotencyKey && !idempotencyKey.success) {
        respondError(res, 400, 'VALIDATION_ERROR', 'The idempotency key must be a UUID.');
        return;
      }
      const result = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(postComments)
          .values({
            postId: req.params.postId,
            userId: user.id,
            text: parsedText.data,
            ...(idempotencyKey?.success ? { idempotencyKey: idempotencyKey.data } : {}),
          })
          .onConflictDoNothing()
          .returning({
            id: postComments.id,
            postId: postComments.postId,
            userId: postComments.userId,
            text: postComments.text,
            createdAt: postComments.createdAt,
          });
        let created = inserted;
        if (!created && idempotencyKey?.success) {
          const [existing] = await tx
            .select({
              id: postComments.id,
              postId: postComments.postId,
              userId: postComments.userId,
              text: postComments.text,
              createdAt: postComments.createdAt,
            })
            .from(postComments)
            .where(
              and(
                eq(postComments.userId, user.id),
                eq(postComments.idempotencyKey, idempotencyKey.data),
              ),
            )
            .limit(1);
          if (!existing || existing.postId !== req.params.postId || existing.text !== parsedText.data) {
            return { kind: 'key_conflict' as const };
          }
          created = existing;
        }
        if (!created) throw new Error('Comment creation did not return a row.');
        if (inserted && post.userId !== user.id) {
          await tx.insert(notifications).values({
            recipientId: post.userId,
            actorId: user.id,
            type: 'comment',
            postId: req.params.postId,
            commentId: created.id,
          });
        }
        return { kind: 'created' as const, comment: created };
      });
      if (result.kind === 'key_conflict') {
        respondError(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used.');
        return;
      }
      const created = result.comment;
      const response = postCommentSchema.parse({
        ...created,
        createdAt: created.createdAt.toISOString(),
        authorId: user.id,
        authorUsername: user.username,
        authorAvatarUrl: user.avatarUrl,
      });
      res.status(201).json({ data: { comment: response } });
    })().catch(next);
  });

  router.delete('/:postId/comments/:commentId', (req, res, next) => {
    void (async () => {
      const db = getDb();
      if (!db) {
        respondError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
        return;
      }
      const user = await currentUser(req);
      if (!user) {
        respondError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
        return;
      }
      if (!validPostId(req.params.postId) || !validPostId(req.params.commentId)) {
        respondError(res, 404, 'NOT_FOUND', 'Comment not found.');
        return;
      }
      if (!(await visiblePost(req.params.postId, user.id))) {
        respondError(res, 404, 'NOT_FOUND', 'Post not found.');
        return;
      }
      const [deleted] = await db
        .delete(postComments)
        .where(
          and(
            eq(postComments.id, req.params.commentId),
            eq(postComments.postId, req.params.postId),
            eq(postComments.userId, user.id),
          ),
        )
        .returning({ id: postComments.id });
      if (!deleted) {
        respondError(res, 404, 'NOT_FOUND', 'Comment not found.');
        return;
      }
      res.status(204).end();
    })().catch(next);
  });

  router.post('/', (req, res, next) => {
    void (async () => {
      const db = getDb();
      if (!db) {
        respondError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
        return;
      }
      const user = await currentUser(req);
      if (!user) {
        respondError(res, 401, 'UNAUTHENTICATED', 'Authentication required.');
        return;
      }
      await runUpload(req, res);
      if (res.headersSent) return;

      const caption = postCaptionSchema.safeParse(req.body?.caption);
      if (!caption.success) {
        respondError(res, 400, 'VALIDATION_ERROR', 'Caption must contain 1 to 2200 characters.');
        return;
      }
      if (!req.file) {
        respondError(res, 400, 'INVALID_UPLOAD', 'Choose an image to publish.');
        return;
      }

      const detected = await fileTypeFromBuffer(req.file.buffer);
      if (!detected || !isSupportedImage(detected.mime)) {
        respondError(res, 415, 'INVALID_UPLOAD', 'Use a JPEG, PNG, or WebP image.');
        return;
      }
      const contentType = detected.mime;
      const imageKey = keyFor(contentType);
      await storage.put(imageKey, req.file.buffer);

      let createdPost;
      try {
        [createdPost] = await db
          .insert(posts)
          .values({
            userId: user.id,
            caption: caption.data,
            imageKey,
            imageContentType: contentType,
          })
          .returning({ id: posts.id, caption: posts.caption, createdAt: posts.createdAt });
      } catch (error) {
        try {
          await storage.remove(imageKey);
        } catch (cleanupError) {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'post_image_cleanup_failed',
              message: cleanupError instanceof Error ? cleanupError.message : 'Unknown error',
            }),
          );
        }
        throw error;
      }

      const body = postResponseSchema.parse({
        ...createdPost,
        imageUrl: `/posts/${createdPost.id}/image`,
        createdAt: createdPost.createdAt.toISOString(),
      });
      res.status(201).json({ data: { post: body } });
    })().catch(next);
  });

  router.get('/:postId/image', (req, res, next) => {
    void (async () => {
      const db = getDb();
      if (!db) {
        respondError(res, 503, 'UNAVAILABLE', 'Service unavailable.');
        return;
      }
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          req.params.postId,
        )
      ) {
        respondError(res, 404, 'NOT_FOUND', 'Post image not found.');
        return;
      }
      const viewer = await currentUser(req);
      const [post] = await db
        .select({
          imageKey: posts.imageKey,
          imageContentType: posts.imageContentType,
        })
        .from(posts)
        .innerJoin(users, eq(posts.userId, users.id))
        .where(
          and(
            eq(posts.id, req.params.postId),
            viewer ? visibleAccount(viewer.id) : eq(users.isPrivate, false),
          ),
        )
        .limit(1);
      if (!post) {
        respondError(res, 404, 'NOT_FOUND', 'Post image not found.');
        return;
      }

      const image = await storage.read(post.imageKey);
      if (!image) {
        respondError(res, 404, 'NOT_FOUND', 'Post image not found.');
        return;
      }
      res
        .type(post.imageContentType)
        .set('X-Content-Type-Options', 'nosniff')
        .set('Cache-Control', 'private, no-store')
        .send(image);
    })().catch(next);
  });

  return router;
}

export const postsRouter = createPostsRouter();
