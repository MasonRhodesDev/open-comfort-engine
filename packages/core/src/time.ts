// RFC 3339 timestamps with an offset (spec §2): the instant, plus the local
// date and minute of day exactly as written — no timezone database.

export interface When {
  t: number; // epoch ms
  date: string; // local YYYY-MM-DD
  minute: number; // local minute of day, fractional (seconds / 60)
}

const RE = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})$/;

export function parseWhen(s: string): When {
  const m = RE.exec(s);
  if (!m) throw new Error("bad timestamp (need RFC 3339 with offset): " + s);
  const [, Y, Mo, D, h, mi, sec, frac, off] = m;
  const secs = Number(sec || 0) + Number(frac || 0);
  let offMin = 0;
  if (off !== "Z" && off !== "z") {
    const sign = off[0] === "-" ? -1 : 1;
    offMin = sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6)));
  }
  const localMs = Date.UTC(Number(Y), Number(Mo) - 1, Number(D), Number(h), Number(mi), 0) + secs * 1000;
  return {
    t: localMs - offMin * 60000,
    date: `${Y}-${Mo}-${D}`,
    minute: Number(h) * 60 + Number(mi) + secs / 60,
  };
}

export function parseHHMM(s: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw new Error("bad HH:MM: " + s);
  const v = Number(m[1]) * 60 + Number(m[2]);
  if (v >= 1440) throw new Error("bad HH:MM: " + s);
  return v;
}

export const MIN = 60000;
