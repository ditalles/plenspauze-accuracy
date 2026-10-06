/**
 * timing.mjs — hoe ver zit elke bron ernaast met het BEGIN van de regen?
 *
 * Alle andere cijfers in score.mjs gaan over "regent het op tijdstip T". Een
 * gebruiker vraagt iets anders: wanneer begint het. Een voorspelling kan de
 * juiste bui hebben en er een half uur naast zitten; dat telt in score.mjs als
 * goed of fout op een manier die die vraag niet beantwoordt.
 *
 * Werkwijze, expres saai:
 *  1. Neem een onafhankelijke waarheid (stationmeting of regenmeter).
 *  2. Zoek de momenten waar hij van droog naar nat gaat, na minstens een half
 *     uur droog. Dat is een bui-START.
 *  3. Pak de opname van ~30 min dáárvoor, toen het nog droog was.
 *  4. Kijk wat elke bron toen zei over wanneer het zou beginnen.
 *  5. Verschil = voorspeld − werkelijk. Negatief = te vroeg voorspeld.
 *
 * Eén meting per bui, niet per opname: anders telt een lange bui twintig keer
 * mee en lijkt n veel groter dan het aantal onafhankelijke gevallen.
 *
 * Draaien:  node timing.mjs [--meter]      (--meter = regenmeter als waarheid)
 */
import { readdir, readFile } from 'node:fs/promises';

const DREMPEL = 0.1;          // mm/u — zelfde grens als de app
const DROOG_VOOR_MIN = 30;    // zo lang droog vóór we het een start noemen
const VOORUIT_MIN = 30;       // hoe lang van tevoren we de voorspelling lezen
const SPELING_MIN = 8;        // hoe ver die opname daarvan af mag liggen
const ZOEK_MIN = 120;         // hoe ver vooruit een bron mag kijken

const gebruikMeter = process.argv.includes('--meter');

const opnames = [];
for (const f of (await readdir('data')).filter((f) => f.endsWith('.ndjson')).sort()) {
  for (const regel of (await readFile(`data/${f}`, 'utf8')).split('\n')) {
    if (!regel.trim()) continue;
    try { opnames.push(JSON.parse(regel)); } catch { /* halve regel bij een afgebroken run */ }
  }
}

/** De waarheid op het moment van de opname. null = niet gemeten. */
function waarheid(r) {
  if (gebruikMeter) return r.waterschap?.mmh ?? null;
  return r.station?.regenNu ?? null;
}

/** Wanneer zegt deze bron dat het begint? Null als hij geen regen ziet. */
function voorspeldeStart(reeks, epoch) {
  if (!reeks?.length) return null;
  // Alleen vooruit kijken, en alleen als het NU nog droog is volgens die bron:
  // anders meten we geen voorspelling maar een constatering.
  const nu = reeks.filter((p) => p.mAhead <= 0).sort((a, b) => b.mAhead - a.mAhead)[0];
  if (nu && nu.mmh >= DREMPEL) return null;
  for (const p of reeks.filter((p) => p.mAhead > 0).sort((a, b) => a.mAhead - b.mAhead)) {
    if (p.mAhead > ZOEK_MIN) break;
    if (p.mmh >= DREMPEL) return epoch + p.mAhead * 60000;
  }
  return null;
}

const perLocatie = {};
for (const r of opnames) (perLocatie[r.loc] ??= []).push(r);

const afwijkingen = { model: [], buienradar: [], knmiradar: [] };
// Hoe vaak had de bron überhaupt een reeks, en hoe vaak zag hij de bui komen?
// Zonder dat is "45% binnen een kwartier" niet te lezen: een bron die maar een
// derde van de buien ziet aankomen, wordt beloond voor wat hij overslaat.
const aanwezig = { model: 0, buienradar: 0, knmiradar: 0 };
let buien = 0;

for (const reeks of Object.values(perLocatie)) {
  reeks.sort((a, b) => a.epoch - b.epoch);
  for (let i = 1; i < reeks.length; i++) {
    const nat = waarheid(reeks[i]);
    const vorig = waarheid(reeks[i - 1]);
    if (nat == null || vorig == null) continue;
    if (!(nat >= DREMPEL && vorig < DREMPEL)) continue;

    // Was het er vóór ook echt droog? Anders is dit geen start maar een dip.
    const start = reeks[i].epoch;
    const voor = reeks.filter(
      (x) => x.epoch >= start - DROOG_VOOR_MIN * 60000 && x.epoch < start,
    );
    if (voor.length < 2 || voor.some((x) => (waarheid(x) ?? 0) >= DREMPEL)) continue;

    // De opname van ~30 min eerder, waarin de bronnen hun voorspelling deden.
    const doel = start - VOORUIT_MIN * 60000;
    const kandidaten = reeks.filter((x) => Math.abs(x.epoch - doel) <= SPELING_MIN * 60000);
    if (!kandidaten.length) continue;
    const v = kandidaten.sort(
      (a, b) => Math.abs(a.epoch - doel) - Math.abs(b.epoch - doel),
    )[0];

    buien++;
    for (const [naam, reeksje] of [
      ['model', v.ours],
      ['buienradar', v.buienradar],
      ['knmiradar', v.knmiradar],
    ]) {
      if (reeksje?.length) aanwezig[naam]++;
      const p = voorspeldeStart(reeksje, v.epoch);
      if (p != null) afwijkingen[naam].push(Math.round((p - start) / 60000));
    }
  }
}

const mediaan = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const kwartiel = (a, q) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

console.log(`\n⏱  Timing van de bui-START  (waarheid: ${gebruikMeter ? 'regenmeter waterschap' : 'KNMI-station'})`);
console.log(`   ${opnames.length} opnames · ${buien} bui-starts gevonden · drempel ${DREMPEL} mm/u`);
console.log(`   Voorspelling gelezen ~${VOORUIT_MIN} min van tevoren. Min = te vroeg voorspeld.\n`);
console.log('   bron            n   mediaan   kwartielen    binnen 15 min   zag de bui');
for (const [naam, a] of Object.entries(afwijkingen)) {
  if (!a.length) { console.log(`   ${naam.padEnd(12)} geen`); continue; }
  const raak = a.filter((x) => Math.abs(x) <= 15).length / a.length;
  const dekking = aanwezig[naam] ? a.length / aanwezig[naam] : 0;
  console.log(
    `   ${naam.padEnd(12)} ${String(a.length).padStart(3)}   ${String(mediaan(a)).padStart(4)} min   ` +
    `${String(kwartiel(a, 0.25)).padStart(4)} … ${String(kwartiel(a, 0.75)).padStart(4)}    ` +
    `${(raak * 100).toFixed(0).padStart(3)}%          ` +
    `${(dekking * 100).toFixed(0).padStart(3)}%  (${a.length}/${aanwezig[naam]})`,
  );
}

// Wat blijft er over ALS je corrigeert? Dat is het getal dat de app toont, dus
// dat moet gemeten worden en niet geschat. De correctie is de mediaan zelf:
// die schuift de hele verdeling naar nul.
console.log('   na correctie met de eigen mediaan:');
console.log('   bron          correctie   binnen 15 min   binnen 10 min');
for (const [naam, a] of Object.entries(afwijkingen)) {
  if (a.length < 10) { console.log(`   ${naam.padEnd(12)} te weinig (${a.length})`); continue; }
  const c = -mediaan(a);
  const na = a.map((x) => x + c);
  const p15 = na.filter((x) => Math.abs(x) <= 15).length / na.length;
  const p10 = na.filter((x) => Math.abs(x) <= 10).length / na.length;
  console.log(
    `   ${naam.padEnd(12)} ${(c > 0 ? '+' : '') + c} min`.padEnd(26) +
    `${(p15 * 100).toFixed(0).padStart(3)}%           ${(p10 * 100).toFixed(0).padStart(3)}%`,
  );
}
console.log();
