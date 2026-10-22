import { eq, or, sql } from 'drizzle-orm';
import { follows, users } from '../db/schema/index.js';

export function visibleAccount(viewerId: string) {
  return or(
    eq(users.isPrivate, false),
    eq(users.id, viewerId),
    sql`exists (
      select 1
      from ${follows}
      where ${follows.followerId} = ${viewerId}
        and ${follows.followedId} = ${users.id}
        and ${follows.status} = 'accepted'
    )`,
  );
}
