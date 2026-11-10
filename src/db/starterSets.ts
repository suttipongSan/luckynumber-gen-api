// Starter sets every new member begins with. Copied from member "PN" on the live site
// (2026-11-10). Created together on the member's first GET /sets; existing members are not
// touched. A lottery id that does not exist (or is another member's custom one) is skipped.
// An entry is a lottery id (round 1) or [id, round].
export interface StarterSet {
  name: string;
  isDefault: boolean;
  lotteries: (string | [string, number])[];
}

export const STARTER_SETS: StarterSet[] = [
  { name: "Default", isDefault: true, lotteries: [] },
  {
    name: "หวยจันทร์-ศุกร์ รอบ 1",
    isDefault: false,
    lotteries: ["hanoi-extra"],
  },
  {
    name: "หวยจันทร์-ศุกร์ รอบ 2",
    isDefault: false,
    lotteries: ["hanoi-asean", "nikkei-morning", "nikkei-morning-vip"],
  },
  {
    name: "หวยจันทร์-ศุกร์ รอบ 3",
    isDefault: false,
    lotteries: ["china-morning", "china-morning-vip", "lao-tv"],
  },
  {
    name: "หวยจันทร์-ศุกร์ รอบ 4",
    isDefault: false,
    lotteries: ["hangseng-morning", "hangseng-morning-vip", "hanoi-hd"],
  },
  {
    name: "หวยจันทร์-ศุกร์ รอบ 5",
    isDefault: false,
    lotteries: ["hanoi-star", "taiwan", "RUfSGhobR86RArCV"],
  },
  {
    name: "หวยจันทร์-ศุกร์ รอบ 6",
    isDefault: false,
    lotteries: [
      "korea",
      "84HmGiFOT3ltp8YG",
      "nikkei-morning",
      "nikkei-morning-vip",
    ],
  },
  {
    name: "หวยจันทร์-ศุกร์ รอบ 7",
    isDefault: false,
    lotteries: ["china-afternoon", "china-afternoon-vip", "lao-hd", "hanoi-tv"],
  },
  {
    name: "หวยจันทร์-ศุกร์ รอบ 8",
    isDefault: false,
    lotteries: ["hangseng-afternoon", "hangseng-afternoon-vip"],
  },
  {
    name: "หวยจันทร์-ศุกร์ รอบ 9",
    isDefault: false,
    lotteries: ["lao-star", "thai-evening", "singapore", "hanoi-kachad"],
  },
  {
    name: "หวยจันทร์-ศุกร์ รอบ 10",
    isDefault: false,
    lotteries: ["hanoi-special", "hanoi-regular", "hanoi-vip"],
  },
  {
    name: "หวยจันทร์-ศุกร์ รอบ 11",
    isDefault: false,
    lotteries: ["lao-pattana", "lao-samakki"],
  },
  {
    name: "หวยจันทร์-ศุกร์ รอบ 12",
    isDefault: false,
    lotteries: ["lao-asean", "lao-vip", "lao-star-vip"],
  },
  {
    name: "หวยจันทร์-ศุกร์ รอบ 13",
    isDefault: false,
    lotteries: ["hanoi-extra", "3states-regular"],
  },
  {
    name: "หวยจันทร์-ศุกร์ รอบ 14",
    isDefault: false,
    lotteries: ["hanoi-kachad", "dow-jones", "dow-jones-vip", "dow-jones-star"],
  },
  {
    name: "หวยเสาร์-อาทิตย์ รอบ 1",
    isDefault: false,
    lotteries: ["lao-extra"],
  },
  {
    name: "หวยเสาร์-อาทิตย์ รอบ 2",
    isDefault: false,
    lotteries: ["hanoi-asean", "nikkei-morning-vip"],
  },
  {
    name: "หวยเสาร์-อาทิตย์ รอบ 3",
    isDefault: false,
    lotteries: ["china-morning-vip", "hangseng-morning-vip", "lao-tv"],
  },
  {
    name: "หวยเสาร์-อาทิตย์ รอบ 4",
    isDefault: false,
    lotteries: ["hanoi-hd", "RUfSGhobR86RArCV"],
  },
  {
    name: "หวยเสาร์-อาทิตย์ รอบ 5",
    isDefault: false,
    lotteries: ["hanoi-star", "84HmGiFOT3ltp8YG"],
  },
  {
    name: "หวยเสาร์-อาทิตย์ รอบ 6",
    isDefault: false,
    lotteries: ["nikkei-afternoon-vip", "lao-hd"],
  },
  {
    name: "หวยเสาร์-อาทิตย์ รอบ 7",
    isDefault: false,
    lotteries: ["china-afternoon-vip", "hanoi-tv"],
  },
  {
    name: "หวยเสาร์-อาทิตย์ รอบ 8",
    isDefault: false,
    lotteries: ["hangseng-afternoon-vip", "lao-star"],
  },
  {
    name: "หวยเสาร์-อาทิตย์ รอบ 9",
    isDefault: false,
    lotteries: ["pr3WP0pcoXEJA5Ku", "hanoi-kachad"],
  },
  {
    name: "หวยเสาร์-อาทิตย์ รอบ 10",
    isDefault: false,
    lotteries: ["hanoi-special", "hanoi-regular", "hanoi-vip"],
  },
  {
    name: "หวยเสาร์-อาทิตย์ รอบ 11",
    isDefault: false,
    lotteries: ["lao-samakki"],
  },
  {
    name: "หวยเสาร์-อาทิตย์ รอบ 12",
    isDefault: false,
    lotteries: ["lao-asean", "lao-vip", "lao-samakki-vip"],
  },
  {
    name: "หวยเสาร์-อาทิตย์ รอบ 13",
    isDefault: false,
    lotteries: ["hanoi-extra", "3states-vip"],
  },
  {
    name: "หวยเสาร์-อาทิตย์ รอบ 14",
    isDefault: false,
    lotteries: ["lao-kachad", "dow-jones-vip", "dow-jones-star"],
  },
  { name: "จบ", isDefault: false, lotteries: [] },
];
