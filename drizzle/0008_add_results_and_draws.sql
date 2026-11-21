CREATE TABLE `lottery_results` (
	`id` text PRIMARY KEY NOT NULL,
	`lottery_id` text NOT NULL,
	`draw_date` text NOT NULL,
	`draw_time` text NOT NULL,
	`top3` text,
	`top2` text,
	`bottom2` text,
	`source` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`lottery_id`) REFERENCES `lotteries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lottery_results_draw_unique_idx` ON `lottery_results` (`lottery_id`,`draw_date`,`draw_time`);--> statement-breakpoint
CREATE INDEX `lottery_results_date_idx` ON `lottery_results` (`draw_date`);--> statement-breakpoint
CREATE TABLE `member_draws` (
	`member_id` text NOT NULL,
	`scope` text NOT NULL,
	`lottery_id` text NOT NULL,
	`card_date` text NOT NULL,
	`numbers` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`member_id`, `scope`, `lottery_id`, `card_date`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_draws_member_date_idx` ON `member_draws` (`member_id`,`card_date`,`scope`,`lottery_id`);