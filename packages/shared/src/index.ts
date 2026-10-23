import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('lumen-api'),
  database: z.enum(['available', 'unavailable']),
  timestamp: z.string().datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const usernameSchema = z
  .string()
  .min(3)
  .max(30)
  .regex(/^[a-zA-Z0-9._]+$/, 'Use letters, numbers, periods, and underscores only.');

/** Absolute URL, or an API path such as /users/avatars/<key>.webp for uploaded photos. */
export const avatarUrlSchema = z.string().max(2048).nullable().optional();

export const postCaptionSchema = z.string().trim().min(1).max(2200);

export const postResponseSchema = z.object({
  id: z.string().uuid(),
  caption: postCaptionSchema,
  imageUrl: z.string().startsWith('/posts/'),
  createdAt: z.string().datetime(),
});

export type PostResponse = z.infer<typeof postResponseSchema>;

export const feedPostSchema = z.object({
  id: z.string().uuid(),
  caption: postCaptionSchema,
  createdAt: z.string().datetime({ offset: true }),
  authorId: z.string().uuid(),
  authorUsername: usernameSchema,
  authorAvatarUrl: avatarUrlSchema,
  imageUrl: z.string().startsWith('/posts/'),
  likeCount: z.number().int().nonnegative(),
  likedByMe: z.boolean(),
  commentCount: z.number().int().nonnegative().optional(),
});

export const postFeedResponseSchema = z.object({
  posts: z.array(feedPostSchema),
  nextCursor: z.string().nullable(),
});

export type FeedPost = z.infer<typeof feedPostSchema>;
export type PostFeedResponse = z.infer<typeof postFeedResponseSchema>;

export const postLikeStateSchema = z.object({
  liked: z.boolean(),
  likeCount: z.number().int().nonnegative(),
});

export const postCommentSchema = z.object({
  id: z.string().uuid(),
  text: z.string().trim().min(1).max(1000),
  createdAt: z.string().datetime({ offset: true }),
  authorId: z.string().uuid(),
  authorUsername: usernameSchema,
  authorAvatarUrl: avatarUrlSchema,
});

export const postCommentsResponseSchema = z.object({
  comments: z.array(postCommentSchema),
  nextCursor: z.string().nullable(),
});

export type FeedPostWithLikes = FeedPost;
export type PostLikeState = z.infer<typeof postLikeStateSchema>;
export type PostComment = z.infer<typeof postCommentSchema>;
export type PostCommentsResponse = z.infer<typeof postCommentsResponseSchema>;

export const followStateSchema = z.enum(['none', 'pending', 'following']);

export const profileSummarySchema = z.object({
  username: usernameSchema,
  displayName: z.string().optional(),
  bio: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  isPrivate: z.boolean(),
  followState: followStateSchema,
  followerCount: z.number().int().nonnegative().nullable(),
  followingCount: z.number().int().nonnegative().nullable(),
});

export type FollowState = z.infer<typeof followStateSchema>;
export type ProfileSummary = z.infer<typeof profileSummarySchema>;

export const discoveredProfileSchema = z.object({
  username: usernameSchema,
  displayName: z.string().optional(),
  avatarUrl: avatarUrlSchema,
  isPrivate: z.boolean(),
  followState: followStateSchema,
});

export const userDiscoveryResponseSchema = z.object({
  users: z.array(discoveredProfileSchema),
  nextCursor: z.string().nullable(),
});

export type DiscoveredProfile = z.infer<typeof discoveredProfileSchema>;
export type UserDiscoveryResponse = z.infer<typeof userDiscoveryResponseSchema>;

export const notificationTypeSchema = z.enum([
  'like',
  'comment',
  'follow',
  'follow_request',
  'follow_approved',
]);

export const notificationSchema = z.object({
  id: z.string().uuid(),
  actorUsername: usernameSchema,
  actorAvatarUrl: avatarUrlSchema,
  type: notificationTypeSchema,
  createdAt: z.string().datetime({ offset: true }),
  readAt: z.string().datetime({ offset: true }).nullable(),
  postId: z.string().uuid().nullable(),
  relatedUsername: usernameSchema.nullable(),
  resourceUrl: z.string().startsWith('/posts/').nullable(),
});

export const notificationsResponseSchema = z.object({
  notifications: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
});

export type NotificationType = z.infer<typeof notificationTypeSchema>;
export type Notification = z.infer<typeof notificationSchema>;
export type NotificationsResponse = z.infer<typeof notificationsResponseSchema>;

export const conversationStatusSchema = z.enum(['pending', 'accepted', 'declined']);

export const conversationSummarySchema = z.object({
  id: z.string().uuid(),
  username: usernameSchema,
  displayName: z.string(),
  avatarUrl: avatarUrlSchema,
  requestStatus: conversationStatusSchema,
  requestedByMe: z.boolean(),
  lastMessageAt: z.string().datetime({ offset: true }),
  unreadCount: z.number().int().nonnegative(),
});

export const conversationsResponseSchema = z.object({
  conversations: z.array(conversationSummarySchema),
  nextCursor: z.string().nullable(),
});

export const directMessageSchema = z.object({
  id: z.string().uuid(),
  senderId: z.string().uuid(),
  senderUsername: usernameSchema,
  text: z.string().trim().min(1).max(2000),
  createdAt: z.string().datetime({ offset: true }),
});

export const directMessagesResponseSchema = z.object({
  messages: z.array(directMessageSchema),
  nextCursor: z.string().nullable(),
});

export type ConversationStatus = z.infer<typeof conversationStatusSchema>;
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type ConversationsResponse = z.infer<typeof conversationsResponseSchema>;
export type DirectMessage = z.infer<typeof directMessageSchema>;
export type DirectMessagesResponse = z.infer<typeof directMessagesResponseSchema>;
