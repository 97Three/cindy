ALTER TABLE `session_pr_refs` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `session_pr_refs` ADD `priority` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_pr_refs` ADD `manually_added` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `session_pr_refs` ADD `removed_at` integer;