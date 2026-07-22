import { getTodayStr, getNowMinutesInArgentina, dayOfWeekFromFechaStr, parseFecha } from "../lib/parse-fecha";

const now = Date.now();
const todayStr = getTodayStr(now);
const nowMin = getNowMinutesInArgentina(now);
console.log({
  iso: new Date(now).toISOString(),
  todayStr,
  nowMin,
  nowHHMM: `${String(Math.floor(nowMin/60)).padStart(2,"0")}:${String(nowMin%60).padStart(2,"0")}`,
  dow: dayOfWeekFromFechaStr(todayStr),
  parse_hoy: parseFecha("hoy"),
  parse_phrase: parseFecha("Tienes para hoy?"),
});

const inicio = 11 * 60, fin = 13 * 60, dur = 45;
const slots: string[] = [];
for (let t = inicio; t + dur <= fin; t += dur) {
  const past = t + 5 <= nowMin;
  slots.push(`${String(Math.floor(t/60)).padStart(2,"0")}:${String(t%60).padStart(2,"0")}${past ? " PAST" : " OK"}`);
}
console.log("francisco wed masaje slots:", slots);
