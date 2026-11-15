CREATE TABLE `agreement_events` (
	`id` text PRIMARY KEY NOT NULL,
	`agreement_id` text NOT NULL,
	`seq` integer NOT NULL,
	`event_type` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_ref` text,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`agreement_id`) REFERENCES `agreements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agreement_events_agreement_seq_uq` ON `agreement_events` (`agreement_id`,`seq`);--> statement-breakpoint
CREATE TABLE `agreements` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`seller_id` text NOT NULL,
	`buyer_name` text NOT NULL,
	`buyer_phone` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`acceptance_criteria` text NOT NULL,
	`due_date` text,
	`total_cents` integer NOT NULL,
	`terms_json` text,
	`terms_sha256` text,
	`terms_version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`shared_at` integer,
	`buyer_accepted_at` integer,
	`buyer_accepted_name` text,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`write_id` text,
	FOREIGN KEY (`seller_id`) REFERENCES `sellers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agreements_code_unique` ON `agreements` (`code`);--> statement-breakpoint
CREATE INDEX `agreements_seller_updated_idx` ON `agreements` (`seller_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `buyer_access` (
	`id` text PRIMARY KEY NOT NULL,
	`agreement_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_ciphertext` text NOT NULL,
	`issued_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`agreement_id`) REFERENCES `agreements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `buyer_access_token_hash_unique` ON `buyer_access` (`token_hash`);--> statement-breakpoint
CREATE TABLE `counters` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `demo_bank_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`alias` text NOT NULL,
	`pey_bank_account_id` text NOT NULL,
	`clabe_last4` text NOT NULL,
	`codi_status` text DEFAULT 'PENDING' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`verified_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_bank_accounts_pey_bank_account_id_unique` ON `demo_bank_accounts` (`pey_bank_account_id`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`agreement_id` text NOT NULL,
	`milestone_id` text NOT NULL,
	`delivery_round` integer DEFAULT 0 NOT NULL,
	`uploaded_by` text NOT NULL,
	`r2_key` text NOT NULL,
	`sha256` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`submitted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agreement_id`) REFERENCES `agreements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`milestone_id`) REFERENCES `milestones`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `evidence_agreement_idx` ON `evidence` (`agreement_id`);--> statement-breakpoint
CREATE TABLE `milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`agreement_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`delivery_round` integer DEFAULT 0 NOT NULL,
	`approved_at` integer,
	`paid_at` integer,
	FOREIGN KEY (`agreement_id`) REFERENCES `agreements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `milestones_agreement_kind_uq` ON `milestones` (`agreement_id`,`kind`);--> statement-breakpoint
CREATE TABLE `payment_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`milestone_id` text NOT NULL,
	`method` text NOT NULL,
	`provider` text DEFAULT 'PEY' NOT NULL,
	`provider_qr_id` text,
	`provider_transaction_id` text,
	`provider_bank_account_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`num_ref` text NOT NULL,
	`qr_string` text,
	`phone_last4` text,
	`idempotency_key` text,
	`status` text NOT NULL,
	`failure_reason` text,
	`last_reconciled_at` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`paid_at` integer,
	FOREIGN KEY (`milestone_id`) REFERENCES `milestones`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_requests_provider_transaction_id_unique` ON `payment_requests` (`provider_transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_requests_active_milestone_uq` ON `payment_requests` (`milestone_id`) WHERE "payment_requests"."status" IN ('CREATING','AWAITING_PAYMENT','CREATION_UNKNOWN');--> statement-breakpoint
CREATE INDEX `payment_requests_qr_idx` ON `payment_requests` (`provider_qr_id`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`milestone_id` text NOT NULL,
	`delivery_round` integer NOT NULL,
	`decision` text NOT NULL,
	`comment` text,
	`buyer_name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`milestone_id`) REFERENCES `milestones`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sellers` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`trade` text NOT NULL,
	`demo_bank_account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`demo_bank_account_id`) REFERENCES `demo_bank_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sellers_demo_bank_account_id_unique` ON `sellers` (`demo_bank_account_id`);--> statement-breakpoint
CREATE TABLE `webhook_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`webhook_id` text NOT NULL,
	`event_type` text NOT NULL,
	`transaction_id` text,
	`payment_request_id` text,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	`processing_status` text NOT NULL,
	`unmatched_reason` text,
	`payload_redacted_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_receipts_provider_webhook_uq` ON `webhook_receipts` (`provider`,`webhook_id`);