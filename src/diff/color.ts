export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 解析 #RGB/#RRGGBB/#RRGGBBAA/rgb()/rgba() → 0-255 RGBA */
export function parseColor(input: string | undefined): Rgba | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();

  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  m = s.match(/^#([0-9a-f]{4})$/);
  if (m) {
    const [r, g, b, a] = m[1].split("").map((c) => parseInt(c + c, 16));
    return { r, g, b, a: round3(a / 255) };
  }
  m = s.match(/^#([0-9a-f]{6})$/);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  m = s.match(/^#([0-9a-f]{8})$/);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 24) & 255, g: (n >> 16) & 255, b: (n >> 8) & 255, a: round3((n & 255) / 255) };
  }
  m = s.match(/^rgba?\(\s*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)(?:[,\s/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    const aRaw = m[4];
    let a = 1;
    if (aRaw !== undefined) a = aRaw.endsWith("%") ? parseFloat(aRaw) / 100 : parseFloat(aRaw);
    return { r: +m[1], g: +m[2], b: +m[3], a: round3(a) };
  }
  // 命名色等无法解析的情况
  return null;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function hex2(v: number): string {
  return Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
}

/** RGB → #RRGGBB。token 表查找与报告展示共用同一套归一化，两处不会各写一份。 */
export function toHex6(r: number, g: number, b: number): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/**
 * 颜色值统一成 hex，供报告左右两侧对照。
 *
 * DOM 侧 getComputedStyle 给的是 `rgb(37, 54, 235)`，设计侧是 `#2536eb` ——
 * 同一行里两种写法并排，人眼判断不出差在哪一位。设计侧本来就是 hex，走同一个
 * 函数是为了对称：以后哪一侧的来源格式变了，两边同时跟着变。
 *
 * 透明度不抹掉（它本身可能就是差异所在），alpha < 1 时输出 8 位。
 * 命名色（`red`、`currentColor`）解析不出来时原样返回，不伪造一个值。
 */
export function formatColor(input: string | undefined): string {
  if (!input) return "—";
  const c = parseColor(input);
  if (!c) return input;
  return c.a >= 1 ? toHex6(c.r, c.g, c.b) : `${toHex6(c.r, c.g, c.b)}${hex2(c.a * 255)}`;
}

/** sRGB → CIE L*a*b* */
function rgbToLab({ r, g, b }: Rgba): [number, number, number] {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const [rl, gl, bl] = [f(r), f(g), f(b)];
  const X = rl * 0.4124 + gl * 0.3576 + bl * 0.1805;
  const Y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  const Z = rl * 0.0193 + gl * 0.1192 + bl * 0.9505;
  const kXn = 0.95047;
  const kZn = 1.08883;
  const g2 = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = g2(X / kXn);
  const fy = g2(Y / 1.0);
  const fz = g2(Z / kZn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 色差（0=完全一致；JND≈2.3） */
export function deltaE2000(c1: string | undefined, c2: string | undefined): number | null {
  const a = parseColor(c1);
  const b = parseColor(c2);
  if (!a || !b || a.a === 0 || b.a === 0) return null;

  const [L1, A1, B1] = rgbToLab(a);
  const [L2, A2, B2] = rgbToLab(b);

  const kL = 1, kC = 1, kH = 1;
  const C1 = Math.sqrt(A1 * A1 + B1 * B1);
  const C2 = Math.sqrt(A2 * A2 + B2 * B2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));

  const a1p = A1 * (1 + G);
  const a2p = A2 * (1 + G);
  const C1p = Math.sqrt(a1p * a1p + B1 * B1);
  const C2p = Math.sqrt(a2p * a2p + B2 * B2);

  const hp = (x: number, y: number) => {
    if (x === 0 && y === 0) return 0;
    const deg = (Math.atan2(y, x) * 180) / Math.PI;
    return deg < 0 ? deg + 360 : deg;
  };
  const h1p = hp(a1p, B1);
  const h2p = hp(a2p, B2);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(((dhp / 2) * Math.PI) / 180);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbarp = (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2;
    else hbarp = (h1p + h2p) / 2;
  } else {
    hbarp = h1p + h2p;
  }

  const T =
    1 -
    0.17 * Math.cos(((hbarp - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * hbarp * Math.PI) / 180) +
    0.32 * Math.cos(((3 * hbarp + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * hbarp - 63) * Math.PI) / 180);

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
  const Lbarp50sq = (Lbarp - 50) * (Lbarp - 50);

  const Sl = 1 + (0.015 * Lbarp50sq) / Math.sqrt(20 + Lbarp50sq);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Rc * Math.sin((2 * dTheta * Math.PI) / 180);

  const termL = dLp / (kL * Sl);
  const termC = dCp / (kC * Sc);
  const termH = dHp / (kH * Sh);
  return Math.sqrt(termL * termL + termC * termC + termH * termH + Rt * termC * termH);
}
