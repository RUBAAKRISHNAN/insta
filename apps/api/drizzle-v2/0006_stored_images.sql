CREATE TABLE "stored_images" (
	"key" text PRIMARY KEY NOT NULL,
	"contents" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
