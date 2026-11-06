CREATE TABLE `admin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`kind` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`r2_key` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `assets_member_idx` ON `assets` (`member_id`);--> statement-breakpoint
CREATE TABLE `card_settings` (
	`member_id` text NOT NULL,
	`lottery_id` text NOT NULL,
	`settings_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`member_id`, `lottery_id`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lottery_id`) REFERENCES `lotteries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `lotteries` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`short_name` text NOT NULL,
	`group_key` text NOT NULL,
	`accent` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `member_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_sessions_member_idx` ON `member_sessions` (`member_id`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`link_token` text NOT NULL,
	`password_hash` text,
	`expires_at` text NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`last_login_at` text,
	`created_at` text NOT NULL,
	`renders_total` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_link_token_unique` ON `members` (`link_token`);--> statement-breakpoint
CREATE TABLE `news` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`detail_html` text NOT NULL,
	`published_at` text NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `news_reads` (
	`member_id` text NOT NULL,
	`news_id` text NOT NULL,
	PRIMARY KEY(`member_id`, `news_id`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`news_id`) REFERENCES `news`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `render_counters` (
	`member_id` text NOT NULL,
	`day` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`member_id`, `day`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `set_lotteries` (
	`set_id` text NOT NULL,
	`lottery_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`set_id`, `lottery_id`),
	FOREIGN KEY (`set_id`) REFERENCES `sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lottery_id`) REFERENCES `lotteries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sets` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sets_member_idx` ON `sets` (`member_id`);