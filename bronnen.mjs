/**
 * bronnen.mjs — klaagt als een bron stilvalt.
 *
 * WAAROM DIT BESTAAT. Op 6 oktober 2026 bleek dat de KNMI-radar en de
 * EDR-stations al 26 dagen niets logden: hun sleutels waren verlopen en de
 * vervangers stonden niet als secret klaar. En de Samen Meten-bron had nooit
 * gedraaid, omdat hij wel geschreven maar nooit gecommit was.
 *
 * Geen van beide viel op. De logger bleef vrolijk draaien en netjes bestanden
 * wegschrijven — alleen stonden er in elke regel twee velden minder. Een stille
 * storing in een meetopstelling is erger dan een luide: je blijft cijfers maken
 * en je blijft ze geloven.
 *
 * Deze controle draait na elke logronde en zegt NEE als een bron een etmaal lang
 * niets opleverde terwijl de rest wél werkte. Dat "terwijl de rest wél werkte"
 * is belangrijk: ligt het hele internet eruit, dan is dat geen kapotte bron maar
 * een kapotte ronde, en daar hoef je geen mail over.
 *
 * Draaien:  node bronnen.mjs [--uren 24]
 * Afloop:   0 = alles in orde, 1 = er is een bron stil
 */
import { readdir, readFile } from 'node:fs/promises';

const urenArg = process.argv.indexOf('--uren');
const UREN = urenArg > -1 ? Number(process.argv[urenArg + 1]) : 24;

/**
 * Wat we verwachten per opname. `altijd` = deze bron hoort er bij élke opname te
 * zijn; is hij weg, dan is er iets kapot.
 *
 * `soms` = mag ontbreken zonder dat er iets mis is. Samen Meten bijvoorbeeld
 * levert alleen iets als er een levende sensor in de buurt staat, en dat is lang
 * niet overal. Voor die bronnen kijken we of ze over het hele etmaal íets gaven.
 */
const BRONNEN = [
  { naam: 'model (Open-Meteo)', veld: (d) => d.ours?.length, altijd: true },
  { naam: 'KNMI-model', veld: (d) => d.knmi?.length, altijd: true },
  { naam: 'Buienradar', veld: (d) => d.buienradar?.length, altijd: true },
  { naam: 'KNMI-radar (WMS)', veld: (d) => d.knmiradar?.length, altijd: true },
  { naam: 'station', veld: (d) => d.station?.regenNu != null, altijd: true },
  { naam: 'regenmeter (waterschap)', veld: (d) => d.waterschap?.mmh != null, altijd: true },
  { naam: 'EDR-station', veld: (d) => !!d.edrstation, altijd: false },
  { naam: 'radar op de meter', veld: (d) => !!d.meterRadar, altijd: false },
  { naam: 'Samen Meten', veld: (d) => !!d.samenmeten, altijd: false },
];

const grens = Date.now() - UREN * 3600_000;
const opnames = [];
for (const f of (await readdir('data')).filter((f) => f.endsWith('.ndjson')).sort().slice(-3)) {
  for (const regel of (await readFile(`data/${f}`, 'utf8')).split('\n')) {
    if (!regel.trim()) continue;
    try {
      const d = JSON.parse(regel);
      if (d.epoch >= grens) opnames.push(d);
    } catch {
      /* halve regel bij een afgebroken run */
    }
  }
}

console.log(`\n🔍 Bronnen over de laatste ${UREN} uur — ${opnames.length} opnames\n`);

if (!opnames.length) {
  console.log('   Geen opnames. De logger zelf draait niet.');
  process.exit(1);
}

const tel = BRONNEN.map((b) => ({
  ...b,
  n: opnames.filter((d) => b.veld(d)).length,
}));

// Draaide de ronde überhaupt? Als álles leeg is, is het netwerk stuk en niet
// een bron. Dan heeft mailen geen zin.
const levend = tel.filter((b) => b.n > 0).length;
const alleStil = levend === 0;

let stil = 0;
for (const b of tel) {
  const pct = ((b.n / opnames.length) * 100).toFixed(0);
  const kapot = b.n === 0 || (b.altijd && b.n < opnames.length * 0.5);
  if (kapot) stil++;
  console.log(
    `   ${kapot ? '✗' : '✓'}  ${b.naam.padEnd(26)} ${String(b.n).padStart(5)} / ${opnames.length}  (${pct.padStart(3)}%)` +
      (kapot ? '   ← STIL' : ''),
  );
}

if (alleStil) {
  console.log('\n   Alles stil: dit is de ronde zelf, geen losse bron.');
  process.exit(1);
}
if (stil) {
  console.log(`\n   ${stil} bron(nen) stil. Meestal is dat een verlopen sleutel.`);
  console.log('   Controleer de secrets KNMI_OPENDATA_KEY, KNMI_WMS_KEY en KNMI_EDR_KEY,');
  console.log('   en haal zo nodig nieuwe op bij developer.dataplatform.knmi.nl.');
  process.exit(1);
}
console.log('\n   Alle bronnen leveren.\n');
