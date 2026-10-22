import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const follows = pgTable(
  'follows',
  {
    followerId: uuid('follower_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followedId: uuid('followed_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('follows_follower_followed_unique').on(table.followerId, table.followedId),
    check('follows_status_check', sql`${table.status} in ('pending', 'accepted')`),
    check('follows_no_self_follow_check', sql`${table.followerId} <> ${table.followedId}`),
    index('follows_follower_status_idx').on(table.followerId, table.status),
    index('follows_followed_status_idx').on(table.followedId, table.status),
  ],
);
