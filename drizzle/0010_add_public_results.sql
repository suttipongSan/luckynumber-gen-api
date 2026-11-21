-- Public results site: a per-lottery on/off switch (public_enabled, default on), the schedule of each
-- catalog lottery (lottery_schedules) and an index for "the official rows of one lottery, newest first"
-- (lottery_results_official_idx). The three statements below are the ones drizzle-kit generated; only
-- this comment and the last statement are by hand. The last one starts the version counter of the public
-- snapshots at 1 (the published version stays 0, as it has no row), so the first cron run after the
-- PUBLIC_RESULTS bucket is bound builds every snapshot file once; INSERT OR IGNORE keeps an existing value.
CREATE TABLE `lottery_schedules` (
	`lottery_id` text NOT NULL,
	`draw_time` text NOT NULL,
	`result_time` text NOT NULL,
	`days` text DEFAULT '1234567' NOT NULL,
	`expected_fields` text DEFAULT 'top3,top2,bottom2' NOT NULL,
	`closed_date` text,
	PRIMARY KEY(`lottery_id`, `draw_time`),
	FOREIGN KEY (`lottery_id`) REFERENCES `lotteries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `lotteries` ADD `public_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `lottery_results_official_idx` ON `lottery_results` (`lottery_id`,`member_id`,`draw_date`,`draw_time`);--> statement-breakpoint
INSERT OR IGNORE INTO `site_settings` (`key`, `value`, `updated_at`) VALUES ('results_version', '1', '2026-11-21T00:00:00.000Z');
