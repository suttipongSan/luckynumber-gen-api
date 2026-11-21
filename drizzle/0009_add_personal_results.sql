-- Personal results: a member can type the result of a draw for themselves. member_id is empty for an
-- official result (every row that exists today, the default makes them so) and the member who typed it
-- otherwise. It is NOT NULL because a unique index treats NULLs as distinct (two official rows for one
-- draw would be allowed). The unique index of a draw now includes it, so a personal result and the
-- official one of the same draw sit side by side. lottery_results_member_date_idx replaces the index on
-- the date alone: it serves the readers of one date (the official rows plus the rows of the member who
-- asks) and the delete of all rows of a member. The statements are the ones drizzle-kit generated, only
-- this comment is by hand.
DROP INDEX `lottery_results_date_idx`;--> statement-breakpoint
DROP INDEX `lottery_results_draw_unique_idx`;--> statement-breakpoint
ALTER TABLE `lottery_results` ADD `member_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `lottery_results_member_date_idx` ON `lottery_results` (`member_id`,`draw_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `lottery_results_draw_unique_idx` ON `lottery_results` (`lottery_id`,`draw_date`,`draw_time`,`member_id`);
