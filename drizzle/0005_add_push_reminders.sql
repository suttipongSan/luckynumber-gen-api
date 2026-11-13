CREATE TABLE `member_notifications` (
	`member_id` text NOT NULL,
	`lottery_id` text NOT NULL,
	`notify_time` text,
	`enabled` integer NOT NULL,
	`last_sent_day` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`member_id`, `lottery_id`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lottery_id`) REFERENCES `lotteries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_notifications_due_idx` ON `member_notifications` (`enabled`,`notify_time`);--> statement-breakpoint
CREATE INDEX `member_notifications_lottery_idx` ON `member_notifications` (`lottery_id`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_member_idx` ON `push_subscriptions` (`member_id`);--> statement-breakpoint
ALTER TABLE `lotteries` ADD `notify_time` text;--> statement-breakpoint
ALTER TABLE `lotteries` ADD `notify_enabled` integer DEFAULT false NOT NULL;