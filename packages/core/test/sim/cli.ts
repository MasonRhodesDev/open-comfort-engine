// npm run sim [-- days]: prints per-day votes, discomfort and HVAC minutes.
import { simulate } from "./sim";
import { household } from "./household";

const days = Number(process.argv[2] || 28);
const { stats } = simulate(household(days));
console.log("day  votes(hot/cold)  uncomfortable_min  hvac_min  mean_band_C");
for (const s of stats) console.log(String(s.day).padStart(3), `${String(s.votes).padStart(4)} (${s.hot}/${s.cold})`.padEnd(16), String(s.uncomfortableMin).padStart(10), String(s.hvacMin).padStart(12), s.meanBand.toFixed(2).padStart(10));
const wk = (a: number, b: number, k: "votes" | "uncomfortableMin" | "hvacMin") => stats.slice(a, b).reduce((x, s) => x + s[k], 0);
console.log(`\nweek 1 votes ${wk(0, 7, "votes")}, last week votes ${wk(days - 7, days, "votes")}; week 1 discomfort ${wk(0, 7, "uncomfortableMin")} min, last week ${wk(days - 7, days, "uncomfortableMin")} min; hvac ${wk(0, 7, "hvacMin")} -> ${wk(days - 7, days, "hvacMin")} min`);
