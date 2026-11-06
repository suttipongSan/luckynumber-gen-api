CREATE TABLE `login_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`locked_until` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sets_one_default_idx` ON `sets` (`member_id`) WHERE `is_default` = 1;