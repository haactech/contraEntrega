CREATE TABLE `agreement_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`agreement_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'TODO' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`submitted_at` integer,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agreement_id`) REFERENCES `agreements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agreement_tasks_agreement_position_uq` ON `agreement_tasks` (`agreement_id`,`position`);--> statement-breakpoint
CREATE TABLE `task_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`decision` text NOT NULL,
	`comment` text,
	`reviewer_name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `agreement_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_reviews_task_revision_uq` ON `task_reviews` (`task_id`,`revision_number`);--> statement-breakpoint
ALTER TABLE `agreements` ADD `service_type` text DEFAULT 'GENERIC' NOT NULL;--> statement-breakpoint
ALTER TABLE `agreements` ADD `payment_strategy` text DEFAULT 'ADVANCE_AND_BALANCE' NOT NULL;--> statement-breakpoint
ALTER TABLE `evidence` ADD `task_id` text REFERENCES agreement_tasks(id);--> statement-breakpoint
ALTER TABLE `evidence` ADD `kind` text DEFAULT 'AFTER' NOT NULL;--> statement-breakpoint
ALTER TABLE `evidence` ADD `revision_number` integer;--> statement-breakpoint
CREATE INDEX `evidence_task_revision_idx` ON `evidence` (`task_id`,`revision_number`);