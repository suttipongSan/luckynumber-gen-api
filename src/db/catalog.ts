// Lottery catalog from SPEC.md (same ids/names as the mockup's mock/lotteries.ts), used by
// `npm run seed` and the tests. Accent colours follow the mockup's per-group palette.
import type { Group, Lottery } from '../types'

export const GROUP_PALETTE: Record<Group, string[]> = {
  thai: ['#b91c1c', '#991b1b', '#7f1d1d', '#9f1239', '#a21217'],
  hanoi: ['#be123c', '#9d174d', '#831843', '#7f1d1d', '#9f1239'],
  lao: ['#065f46', '#047857', '#166534', '#15803d', '#14532d'],
  stock: ['#1e3a8a', '#1e40af', '#172554', '#1e293b', '#0f172a'],
  other: ['#4c1d95', '#6b21a8', '#5b21b6', '#581c87', '#3730a3'],
}

/** Display order of groups (DESIGN.md: ฮานอย, ลาว, หุ้น, ไทย, อื่นๆ). */
export const GROUP_ORDER: Group[] = ['hanoi', 'lao', 'stock', 'thai', 'other']

export const GROUP_LABELS: Record<Group, string> = {
  hanoi: 'ฮานอย',
  lao: 'ลาว',
  stock: 'หุ้น',
  thai: 'ไทย',
  other: 'อื่นๆ',
}

type Seed = [id: string, name: string, shortName: string, group: Group]

const SEEDS: Seed[] = [
  // หุ้น
  ['dow-jones', 'ดาวโจนส์', 'ดาวโจนส์', 'stock'],
  ['dow-jones-vip', 'ดาวโจนส์ VIP', 'ดาวโจนส์ VIP', 'stock'],
  ['dow-jones-star', 'ดาวโจนส์ STAR', 'ดาวโจนส์ STAR', 'stock'],
  ['nikkei-morning', 'นิเคอิ เช้า', 'นิเคอิ เช้า', 'stock'],
  ['nikkei-morning-vip', 'นิเคอิ เช้า VIP', 'นิเคอิ เช้า VIP', 'stock'],
  ['nikkei-afternoon', 'นิเคอิ บ่าย', 'นิเคอิ บ่าย', 'stock'],
  ['nikkei-afternoon-vip', 'นิเคอิ บ่าย VIP', 'นิเคอิ บ่าย VIP', 'stock'],
  ['china-morning', 'จีน เช้า', 'จีน เช้า', 'stock'],
  ['china-morning-vip', 'จีน เช้า VIP', 'จีน เช้า VIP', 'stock'],
  ['china-afternoon', 'จีน บ่าย', 'จีน บ่าย', 'stock'],
  ['china-afternoon-vip', 'จีน บ่าย VIP', 'จีน บ่าย VIP', 'stock'],
  ['hangseng-morning', 'ฮั่งเส็ง เช้า', 'ฮั่งเส็ง เช้า', 'stock'],
  ['hangseng-morning-vip', 'ฮั่งเส็ง เช้า VIP', 'ฮั่งเส็ง เช้า VIP', 'stock'],
  ['hangseng-afternoon', 'ฮั่งเส็ง บ่าย', 'ฮั่งเส็ง บ่าย', 'stock'],
  ['hangseng-afternoon-vip', 'ฮั่งเส็ง บ่าย VIP', 'ฮั่งเส็ง บ่าย VIP', 'stock'],
  ['taiwan', 'ไต้หวัน', 'ไต้หวัน', 'stock'],
  ['korea', 'เกาหลี', 'เกาหลี', 'stock'],
  ['singapore', 'สิงคโปร์', 'สิงคโปร์', 'stock'],
  ['india', 'หุ้นอินเดีย', 'อินเดีย', 'stock'],
  ['egypt', 'หุ้นอียิปต์', 'อียิปต์', 'stock'],
  ['germany', 'หุ้นเยอรมัน', 'เยอรมัน', 'stock'],
  ['uk', 'หุ้นอังกฤษ', 'อังกฤษ', 'stock'],
  ['russia', 'หุ้นรัสเซีย', 'รัสเซีย', 'stock'],
  ['brazil', 'หุ้นบราซิล', 'บราซิล', 'stock'],
  ['france', 'หุ้นฝรั่งเศส', 'ฝรั่งเศส', 'stock'],
  ['spain', 'หุ้นสเปน', 'สเปน', 'stock'],

  // ไทย
  ['thai-gov', 'รัฐบาลไทย', 'รัฐบาลไทย', 'thai'],
  ['gsb', 'ออมสิน', 'ออมสิน', 'thai'],
  ['baac', 'ธกส', 'ธกส', 'thai'],
  ['thai-morning', 'หุ้นไทย เช้า', 'ไทยเช้า', 'thai'],
  ['thai-midday', 'หุ้นไทย เที่ยง', 'ไทยเที่ยง', 'thai'],
  ['thai-evening', 'หุ้นไทย เย็น', 'ไทยเย็น', 'thai'],
  ['thai-set', 'หุ้นไทย SET', 'ไทยSET', 'thai'],
  ['thai-set-vip', 'หุ้นไทย SET VIP', 'ไทยSETVIP', 'thai'],

  // ฮานอย
  ['hanoi-regular', 'ฮานอย ปกติ', 'ฮานอยปกติ', 'hanoi'],
  ['hanoi-special', 'ฮานอย พิเศษ', 'ฮานอยพิเศษ', 'hanoi'],
  ['hanoi-vip', 'ฮานอย VIP', 'ฮานอยVIP', 'hanoi'],
  ['hanoi-hd', 'ฮานอย HD', 'ฮานอยHD', 'hanoi'],
  ['hanoi-hdx', 'ฮานอย HD พิเศษ', 'ฮานอยHDพิเศษ', 'hanoi'],
  ['hanoi-tv', 'ฮานอย TV', 'ฮานอยTV', 'hanoi'],
  ['hanoi-tvx', 'ฮานอย TV พิเศษ', 'ฮานอยTVพิเศษ', 'hanoi'],
  ['hanoi-star', 'ฮานอย สตาร์', 'ฮานอยสตาร์', 'hanoi'],
  ['hanoi-kachad', 'ฮานอย กาชาด', 'ฮานอยกาชาด', 'hanoi'],
  ['hanoi-extra', 'ฮานอย Extra', 'ฮานอยExtra', 'hanoi'],
  ['hanoi-asean', 'ฮานอย อาเซียน', 'ฮานอยอาเซียน', 'hanoi'],
  ['hanoi-asean-vip', 'ฮานอย อาเซียน VIP', 'ฮานอยอาเซียนVIP', 'hanoi'],
  ['hanoi-samakki', 'ฮานอย สามัคคี', 'ฮานอยสามัคคี', 'hanoi'],
  ['hanoi-samakki-vip', 'ฮานอย สามัคคี VIP', 'ฮานอยสามัคคีVIP', 'hanoi'],
  ['hanoi-pattana', 'ฮานอย พัฒนา', 'ฮานอยพัฒนา', 'hanoi'],
  ['hanoi-pattana-vip', 'ฮานอย พัฒนา VIP', 'ฮานอยพัฒนาVIP', 'hanoi'],
  ['hanoi-pattana-star', 'ฮานอย พัฒนา STAR', 'ฮานอยพัฒนาSTAR', 'hanoi'],
  ['hanoi-wanon', 'ฮานอย วานร', 'ฮานอยวานร', 'hanoi'],
  ['hanoi-wanon-vip', 'ฮานอย วานร VIP', 'ฮานอยวานรVIP', 'hanoi'],
  ['hanoi-chinese-ny', 'ฮานอย ตรุษจีน', 'ฮานอยตรุษจีน', 'hanoi'],

  // ลาว
  ['lao-pattana', 'ลาว พัฒนา', 'ลาวพัฒนา', 'lao'],
  ['lao-pattana-vip', 'ลาว พัฒนา VIP', 'ลาวพัฒนาVIP', 'lao'],
  ['lao-samakki', 'ลาว สามัคคี', 'ลาวสามัคคี', 'lao'],
  ['lao-samakki-vip', 'ลาว สามัคคี VIP', 'ลาวสามัคคีVIP', 'lao'],
  ['lao-vip', 'ลาว VIP', 'ลาวVIP', 'lao'],
  ['lao-star', 'ลาว สตาร์', 'ลาวสตาร์', 'lao'],
  ['lao-star-vip', 'ลาว สตาร์ VIP', 'ลาวสตาร์VIP', 'lao'],
  ['lao-hd', 'ลาว HD', 'ลาวHD', 'lao'],
  ['lao-hd-vip', 'ลาว HD VIP', 'ลาวHDVIP', 'lao'],
  ['lao-tv', 'ลาว TV', 'ลาวTV', 'lao'],
  ['lao-extra', 'ลาว Extra', 'ลาวExtra', 'lao'],
  ['lao-kachad', 'ลาว กาชาด', 'ลาวกาชาด', 'lao'],
  ['lao-asean', 'ลาว อาเซียน', 'ลาวอาเซียน', 'lao'],
  ['lao-asean-vip', 'ลาว อาเซียน VIP', 'ลาวอาเซียนVIP', 'lao'],
  ['lao-victory', 'ลาว ประตูชัย', 'ลาวประตูชัย', 'lao'],
  ['lao-peace', 'ลาว สันติภาพ', 'ลาวสันติภาพ', 'lao'],
  ['lao-charoen', 'ลาว เจริญ', 'ลาวเจริญ', 'lao'],
  ['lao-people', 'ประชาชนลาว', 'ประชาชนลาว', 'lao'],

  // อื่นๆ
  ['3states-regular', '3 รัฐ ปกติ', '3รัฐปกติ', 'other'],
  ['3states-vip', '3 รัฐ VIP', '3รัฐVIP', 'other'],
  ['malaysia', 'มาเลเซีย', 'มาเลเซีย', 'other'],
  ['indonesia', 'อินโดนีเซีย', 'อินโดนีเซีย', 'other'],
  ['cambodia', 'กัมพูชา', 'กัมพูชา', 'other'],
  ['myanmar', 'เมียนมาร์', 'เมียนมาร์', 'other'],
  ['philippines', 'ฟิลิปปินส์', 'ฟิลิปปินส์', 'other'],
  ['vietnam', 'เวียดนามใต้', 'เวียดนามใต้', 'other'],
  ['vietnam-central', 'เวียดนามกลาง', 'เวียดนามกลาง', 'other'],
  ['australia', 'ออสเตรเลีย', 'ออสเตรเลีย', 'other'],
]

/** Catalog sorted by group order; sortOrder = 10, 20, 30… so admins can insert between. */
export const LOTTERY_CATALOG: Lottery[] = GROUP_ORDER.flatMap((group) =>
  SEEDS.filter((s) => s[3] === group),
).map(([id, name, shortName, group], i) => {
  const groupIndex = SEEDS.filter((s) => s[3] === group).findIndex((s) => s[0] === id)
  const palette = GROUP_PALETTE[group]
  return {
    id,
    name,
    shortName,
    group,
    accent: palette[groupIndex % palette.length],
    sortOrder: (i + 1) * 10,
    active: true,
    custom: false,
  }
})
