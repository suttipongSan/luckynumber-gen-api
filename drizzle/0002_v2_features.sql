ALTER TABLE `lotteries` ADD `owner_member_id` text;--> statement-breakpoint
CREATE INDEX `lotteries_owner_idx` ON `lotteries` (`owner_member_id`);--> statement-breakpoint
ALTER TABLE `set_lotteries` ADD `round` integer DEFAULT 1 NOT NULL;