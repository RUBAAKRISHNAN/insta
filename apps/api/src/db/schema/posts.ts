import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const posts = pgTable(
  'posts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    caption: text('caption').notNull(),
    imageKey: text('image_key').notNull().unique(),
    imageContentType: text('image_content_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('posts_caption_length_check', sql`char_length(${table.caption}) between 1 and 2200`),
    check(
      'posts_image_content_type_check',
      sql`${table.imageContentType} in ('image/jpeg', 'image/png', 'image/webp')`,
    ),
    index('posts_user_created_idx').on(table.userId, table.createdAt),
  ],
);
