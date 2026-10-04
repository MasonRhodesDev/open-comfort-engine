// Per-step working context: the (copied) state, config, parsed time, and the
// effects being collected. Shared by the engine modules.
import type { EngineRecord, FeedbackCode, Params, State, ZoneConfig } from "./types";
import { DEFAULT_PARAMS } from "./types";
import { grid } from "./math";
import type { Grid } from "./model";
import type { When } from "./time";

export function params(config: ZoneConfig): Params {
  return { ...DEFAULT_PARAMS, ...(config.params || {}) };
}

export class Ctx implements Grid {
  p: Params;
  g: number[];
  dirty = false;
  records: EngineRecord[] = [];
  feedback?: FeedbackCode;
  constructor(public s: State, public cfg: ZoneConfig, public w: When, public nowStr: string) {
    this.p = params(cfg);
    this.g = grid(this.p.gridMin, this.p.gridMax, this.p.gridStep);
  }
  rec(type: EngineRecord["type"], fields: Record<string, unknown>): void {
    this.records.push({ type, at: this.nowStr, zone: this.cfg.id, ...fields });
  }
  /** the last outdoor temperature if it is recent enough to act on (§7.4) */
  get out(): number | null {
    const wx = this.s.weather;
    return wx && this.w.t - wx.at <= 3 * 60 * 60000 ? wx.out : null;
  }
  /** the outdoor temperature the band is read at: the last one ever received (§7.1) */
  get outForBand(): number | null {
    return this.s.weather ? this.s.weather.out : null;
  }
  get tin(): number | null {
    return this.s.reading ? this.s.reading.tin : null;
  }
}
