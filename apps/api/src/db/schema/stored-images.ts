import { customType, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Image bytes for the `database` storage adapter. Hosts with ephemeral disks
 * (such as Render's free tier) lose local uploads on every redeploy; rows here
 * live as long as the database does.
 */
export const storedImages = pgTable('stored_images', {
  key: text('key').primaryKey(),
  contents: bytea('contents').notNull(),
  byteSize: integer('byte_size').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
