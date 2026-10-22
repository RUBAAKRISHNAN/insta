import { index, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { posts } from './posts.js';
import { users } from './users.js';

export const postLikes = pgTable(
  'post_likes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('post_likes_user_post_unique').on(table.userId, table.postId),
    index('post_likes_post_idx').on(table.postId),
  ],
);
