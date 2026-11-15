ALTER TABLE `landing_items` ADD `slug` text;--> statement-breakpoint
ALTER TABLE `landing_items` ADD `content_html` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `landing_items` ADD `published_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `landing_items_slug_unique_idx` ON `landing_items` (`slug`) WHERE slug IS NOT NULL;--> statement-breakpoint
-- Data step, written by hand (drizzle-kit only generates the statements above). It has to work on a
-- database where 0006 is already applied and an admin has edited or deleted rows since.
-- The three starter articles get readable addresses. Only a row that still exists, is still an
-- article and has no slug yet is touched: an edited row keeps its new text, a deleted row is skipped.
UPDATE `landing_items` SET `slug` = 'all-lotteries' WHERE `id` = 'landing-article-1' AND `kind` = 'article' AND `slug` IS NULL;--> statement-breakpoint
UPDATE `landing_items` SET `slug` = 'customize-card' WHERE `id` = 'landing-article-2' AND `kind` = 'article' AND `slug` IS NULL;--> statement-breakpoint
UPDATE `landing_items` SET `slug` = 'notify-time' WHERE `id` = 'landing-article-3' AND `kind` = 'article' AND `slug` IS NULL;--> statement-breakpoint
-- Every other article (added by an admin) gets a random address: a- plus 8 lower case hex characters.
-- how-to steps keep slug NULL, content_html empty and published_at NULL.
UPDATE `landing_items` SET `slug` = 'a-' || lower(hex(randomblob(4))) WHERE `kind` = 'article' AND `slug` IS NULL;--> statement-breakpoint
-- An article shows a date: start from the moment the row was created.
UPDATE `landing_items` SET `published_at` = `created_at` WHERE `kind` = 'article' AND `published_at` IS NULL;
