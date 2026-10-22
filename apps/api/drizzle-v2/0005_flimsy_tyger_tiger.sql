CREATE TABLE "conversation_participants" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_participants_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_low_id" uuid NOT NULL,
	"participant_high_id" uuid NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"request_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_participant_order_check" CHECK ("conversations"."participant_low_id" < "conversations"."participant_high_id"),
	CONSTRAINT "conversations_request_status_check" CHECK ("conversations"."request_status" in ('pending', 'accepted', 'declined')),
	CONSTRAINT "conversations_requester_check" CHECK ("conversations"."requested_by_id" in ("conversations"."participant_low_id", "conversations"."participant_high_id"))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"text" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_text_length_check" CHECK (char_length("messages"."text") between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_participant_low_id_users_id_fk" FOREIGN KEY ("participant_low_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_participant_high_id_users_id_fk" FOREIGN KEY ("participant_high_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_participant_fk" FOREIGN KEY ("conversation_id","sender_id") REFERENCES "public"."conversation_participants"("conversation_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_participants_user_idx" ON "conversation_participants" USING btree ("user_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_participants_unique" ON "conversations" USING btree ("participant_low_id","participant_high_id");--> statement-breakpoint
CREATE INDEX "conversations_last_message_idx" ON "conversations" USING btree ("last_message_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "messages_sender_idempotency_unique" ON "messages" USING btree ("sender_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_sender_idx" ON "messages" USING btree ("sender_id");