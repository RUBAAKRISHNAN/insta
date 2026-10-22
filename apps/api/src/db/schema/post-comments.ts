import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { posts } from './posts.js';
import { users } from './users.js';

export const postComments = pgTable(
  'post_comments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    idempotencyKey: uuid('idempotency_key'),
    text: text('text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('post_comments_text_length_check', sql`char_length(${table.text}) between 1 and 1000`),
    index('post_comments_post_created_idx').on(table.postId, table.createdAt, table.id),
    index('post_comments_user_idx').on(table.userId),
    uniqueIndex('post_comments_user_idempotency_unique')
      .on(table.userId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);
