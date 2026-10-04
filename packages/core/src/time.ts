// RFC 3339 timestamps with an offset (spec §2): the instant, plus the local
// date and minute of day exactly as written — no timezone database.

export interface When {
  t: number; // epoch ms
  date: string; // local YYYY-MM-DD
  minute: number; // local minute of day, fractional (seconds / 60)
  offMin: number; // the timestamp's own UTC offset, minutes
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
    offMin,
  };
}

/** An instant as RFC 3339 in the given UTC offset (whole seconds). No Date object: pure arithmetic. */
export function formatWhen(t: number, offMin: number): string {
  const local = Math.floor(t / 1000) + offMin * 60; // seconds since the epoch, shifted into the offset
  const days = Math.floor(local / 86400);
  let rem = local - days * 86400;
  const hh = Math.floor(rem / 3600); rem -= hh * 3600;
  const mi = Math.floor(rem / 60); const ss = rem - mi * 60;
  // civil date from days since 1970-01-01 (Hinnant's algorithm)
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  const two = (n: number) => String(n).padStart(2, "0");
  const sign = offMin < 0 ? "-" : "+";
  const a = Math.abs(offMin);
  return `${y}-${two(m)}-${two(d)}T${two(hh)}:${two(mi)}:${two(ss)}${sign}${two(Math.floor(a / 60))}:${two(a % 60)}`;
}

export function parseHHMM(s: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw new Error("bad HH:MM: " + s);
  const v = Number(m[1]) * 60 + Number(m[2]);
  if (v >= 1440) throw new Error("bad HH:MM: " + s);
  return v;
}

export const MIN = 60000;
