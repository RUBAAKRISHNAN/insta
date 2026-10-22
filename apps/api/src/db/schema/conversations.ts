import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    participantLowId: uuid('participant_low_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    participantHighId: uuid('participant_high_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestedById: uuid('requested_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestStatus: text('request_status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'conversations_participant_order_check',
      sql`${table.participantLowId} < ${table.participantHighId}`,
    ),
    check(
      'conversations_request_status_check',
      sql`${table.requestStatus} in ('pending', 'accepted', 'declined')`,
    ),
    check(
      'conversations_requester_check',
      sql`${table.requestedById} in (${table.participantLowId}, ${table.participantHighId})`,
    ),
    uniqueIndex('conversations_participants_unique').on(
      table.participantLowId,
      table.participantHighId,
    ),
    index('conversations_last_message_idx').on(table.lastMessageAt.desc(), table.id.desc()),
  ],
);

export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: 'conversation_participants_pk',
      columns: [table.conversationId, table.userId],
    }),
    index('conversation_participants_user_idx').on(table.userId, table.conversationId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('messages_text_length_check', sql`char_length(${table.text}) between 1 and 2000`),
    foreignKey({
      name: 'messages_sender_participant_fk',
      columns: [table.conversationId, table.senderId],
      foreignColumns: [
        conversationParticipants.conversationId,
        conversationParticipants.userId,
      ],
    }).onDelete('cascade'),
    uniqueIndex('messages_sender_idempotency_unique').on(table.senderId, table.idempotencyKey),
    index('messages_conversation_created_idx').on(
      table.conversationId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('messages_sender_idx').on(table.senderId),
  ],
);
