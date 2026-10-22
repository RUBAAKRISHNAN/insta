CREATE TABLE "follows" (
	"follower_id" uuid NOT NULL,
	"followed_id" uuid NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_follower_followed_unique" UNIQUE("follower_id","followed_id"),
	CONSTRAINT "follows_status_check" CHECK ("follows"."status" in ('pending', 'accepted')),
	CONSTRAINT "follows_no_self_follow_check" CHECK ("follows"."follower_id" <> "follows"."followed_id")
);
--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_followed_id_users_id_fk" FOREIGN KEY ("followed_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follows_follower_status_idx" ON "follows" USING btree ("follower_id","status");--> statement-breakpoint
CREATE INDEX "follows_followed_status_idx" ON "follows" USING btree ("followed_id","status");