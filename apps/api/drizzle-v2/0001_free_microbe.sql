CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"caption" text NOT NULL,
	"image_key" text NOT NULL,
	"image_content_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posts_image_key_unique" UNIQUE("image_key"),
	CONSTRAINT "posts_caption_length_check" CHECK (char_length("posts"."caption") between 1 and 2200),
	CONSTRAINT "posts_image_content_type_check" CHECK ("posts"."image_content_type" in ('image/jpeg', 'image/png', 'image/webp'))
);
--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posts_user_created_idx" ON "posts" USING btree ("user_id","created_at");