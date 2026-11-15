CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`label` text NOT NULL,
	`key_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`seller_id`) REFERENCES `sellers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`agreement_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`assistant_lock_until` integer,
	`assistant_snapshot_seq` integer DEFAULT 0 NOT NULL,
	`assistant_pending_seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`seller_id`) REFERENCES `sellers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_agreement_id_unique` ON `conversations` (`agreement_id`);--> statement-breakpoint
CREATE INDEX `conversations_seller_updated_idx` ON `conversations` (`seller_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`outcome` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `llm_calls_conversation_idx` ON `llm_calls` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`author_type` text NOT NULL,
	`author_name` text NOT NULL,
	`kind` text NOT NULL,
	`body_text` text NOT NULL,
	`proposal_id` text,
	`llm_call_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_seq_uq` ON `messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`version` integer NOT NULL,
	`terms_json` text NOT NULL,
	`terms_sha256` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`confirmed_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposals_conversation_version_uq` ON `proposals` (`conversation_id`,`version`);