CREATE TABLE `landing_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`image_key` text,
	`sort_order` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `landing_items_kind_sort_idx` ON `landing_items` (`kind`,`sort_order`);--> statement-breakpoint
-- Starter content so the public landing page is not empty at launch (3 articles, 3 how-to steps).
-- The single-value texts and colours need no rows: GET /landing falls back to the defaults in
-- src/lib/landing.ts until an admin saves them. Timestamps use the ISO format of Date#toISOString.
INSERT INTO `landing_items` (`id`, `kind`, `title`, `body`, `image_key`, `sort_order`, `active`, `created_at`, `updated_at`) VALUES
	('landing-article-1', 'article', 'ครบทุกหวย ทุกรอบ', 'ฮานอย ลาว หุ้น และหวยอื่น ๆ พร้อมใช้ทันที เพิ่มหวยของตัวเองได้ จัดเป็นชุดตามรอบเวลาที่ลง', NULL, 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('landing-article-2', 'article', 'ปรับแต่งได้ทั้งใบ', 'เปลี่ยนพื้นหลัง โลโก้ ฟอนต์ สี ขนาดกรอบ ใส่ QR และข้อความของคุณเอง บันทึกดีไซน์ไว้ใช้ได้ทุกวัน', NULL, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('landing-article-3', 'article', 'แจ้งเตือนเมื่อถึงเวลาลง', 'ตั้งเวลาลงของแต่ละหวย ระบบเตือนบนมือถือและคอมเมื่อถึงเวลา ไม่พลาดทุกรอบ', NULL, 2, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('landing-howto-1', 'howto', 'เปิดลิงก์ส่วนตัว', 'สมัครผ่าน Line หรือ Telegram ทีมงานจะส่งลิงก์ส่วนตัวให้ เปิดแล้วตั้งรหัสผ่านได้เลย', NULL, 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('landing-howto-2', 'howto', 'เลือกหวย แล้วกดสุ่ม', 'เลือกหวยที่ต้องการ กำหนดเลขวิ่งเองหรือให้ระบบสุ่ม แล้วปรับหน้าตาใบตามชอบ', NULL, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	('landing-howto-3', 'howto', 'ดาวน์โหลดหรือคัดลอก', 'ดาวน์โหลดเป็นรูป คัดลอก หรือแชร์ได้ทันที ทำทีละใบหรือทั้งชุดก็ได้', NULL, 2, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));