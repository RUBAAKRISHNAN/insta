ALTER TABLE "users" ADD COLUMN "is_private" boolean DEFAULT false NOT NULL;
CREATE TABLE "sessions" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "user_id" uuid NOT NULL, "token_hash" text NOT NULL UNIQUE, "expires_at" timestamp with time zone NOT NULL, "revoked_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade);
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");
