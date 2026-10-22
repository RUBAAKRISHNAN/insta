import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { postComments } from './post-comments.js';
import { posts } from './posts.js';
import { users } from './users.js';

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }),
    commentId: uuid('comment_id').references(() => postComments.id, { onDelete: 'cascade' }),
    relatedUserId: uuid('related_user_id').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'notifications_type_check',
      sql`${table.type} in ('like', 'comment', 'follow', 'follow_request', 'follow_approved')`,
    ),
    check('notifications_no_self_check', sql`${table.recipientId} <> ${table.actorId}`),
    check(
      'notifications_resource_check',
      sql`(
        (${table.type} = 'like' and ${table.postId} is not null and ${table.commentId} is null and ${table.relatedUserId} is null)
        or (${table.type} = 'comment' and ${table.postId} is not null and ${table.commentId} is not null and ${table.relatedUserId} is null)
        or (${table.type} in ('follow', 'follow_request', 'follow_approved') and ${table.postId} is null and ${table.commentId} is null and ${table.relatedUserId} is not null)
      )`,
    ),
    index('notifications_recipient_created_idx').on(
      table.recipientId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('notifications_recipient_unread_created_idx')
      .on(table.recipientId, table.createdAt.desc(), table.id.desc())
      .where(sql`${table.readAt} is null`),
    uniqueIndex('notifications_comment_unique')
      .on(table.commentId)
      .where(sql`${table.type} = 'comment' and ${table.commentId} is not null`),
  ],
);
