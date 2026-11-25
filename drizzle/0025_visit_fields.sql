ALTER TABLE "appointments" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;
