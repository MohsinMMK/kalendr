CREATE TABLE "rate_limit_buckets" (
	"key_hash" varchar(64) NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "rate_limit_buckets_pk" PRIMARY KEY("key_hash","window_start"),
	CONSTRAINT "rate_limit_buckets_count_positive" CHECK ("rate_limit_buckets"."count" > 0)
);
--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_window_end_idx" ON "rate_limit_buckets" USING btree ("window_end");