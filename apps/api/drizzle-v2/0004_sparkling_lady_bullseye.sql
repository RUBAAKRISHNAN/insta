CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"type" text NOT NULL,
	"post_id" uuid,
	"comment_id" uuid,
	"related_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('like', 'comment', 'follow', 'follow_request', 'follow_approved')),
	CONSTRAINT "notifications_no_self_check" CHECK ("notifications"."recipient_id" <> "notifications"."actor_id"),
	CONSTRAINT "notifications_resource_check" CHECK ((
        ("notifications"."type" = 'like' and "notifications"."post_id" is not null and "notifications"."comment_id" is null and "notifications"."related_user_id" is null)
        or ("notifications"."type" = 'comment' and "notifications"."post_id" is not null and "notifications"."comment_id" is not null and "notifications"."related_user_id" is null)
        or ("notifications"."type" in ('follow', 'follow_request', 'follow_approved') and "notifications"."post_id" is null and "notifications"."comment_id" is null and "notifications"."related_user_id" is not null)
      ))
);
--> statement-breakpoint
ALTER TABLE "post_comments" ADD COLUMN "idempotency_key" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_comment_id_post_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."post_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_related_user_id_users_id_fk" FOREIGN KEY ("related_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_recipient_created_idx" ON "notifications" USING btree ("recipient_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_recipient_unread_created_idx" ON "notifications" USING btree ("recipient_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_comment_unique" ON "notifications" USING btree ("comment_id") WHERE "notifications"."type" = 'comment' and "notifications"."comment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "post_comments_user_idempotency_unique" ON "post_comments" USING btree ("user_id","idempotency_key") WHERE "post_comments"."idempotency_key" is not null;