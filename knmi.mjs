/**
 * knmi.mjs — KNMI Data Platform Open Data API: haalt de nieuwste officiële
 * weerwaarschuwingen (code geel/oranje/rood incl. onweer) op.
 * Bestand-gebaseerd: lijst bestanden → download-URL → download → toon.
 *
 * Key: gratis via developer.dataplatform.knmi.nl (of de anonieme voorbeeld-key).
 * Draaien:  KNMI_API_KEY=... node knmi.mjs [datasetName] [versionId]
 */
const BASE = 'https://api.dataplatform.knmi.nl/open-data/v1';
const KEY = process.env.KNMI_API_KEY;
const DATASET = process.argv[2] ?? 'waarschuwingen_nederland_48h';
const VERSION = process.argv[3] ?? '1.0';

if (!KEY) {
  console.error('Zet KNMI_API_KEY in de omgeving.  KNMI_API_KEY=xxx node knmi.mjs');
  process.exit(1);
}
const H = { Authorization: KEY };

async function j(url) {
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(`${r.status} @ ${url}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

console.log(`KNMI Open Data · ${DATASET} v${VERSION}\n`);
try {
  // 1. Nieuwste bestand (sorteer aflopend op laatst gewijzigd).
  const list = await j(
    `${BASE}/datasets/${DATASET}/versions/${VERSION}/files` +
      `?maxKeys=1&orderBy=lastModified&sorting=desc`,
  );
  const file = list.files?.[0];
  if (!file) throw new Error('geen bestanden gevonden');
  console.log(`✓ nieuwste bestand: ${file.filename}  (${file.lastModified ?? '?'})`);

  // 2. Tijdelijke download-URL.
  const { temporaryDownloadUrl } = await j(
    `${BASE}/datasets/${DATASET}/versions/${VERSION}/files/${encodeURIComponent(file.filename)}/url`,
  );

  // 3. Downloaden + tonen (waarschuwingen zijn TXT/XML).
  const res = await fetch(temporaryDownloadUrl);
  const body = await res.text();
  console.log('\n── inhoud (eerste 1500 tekens) ──\n');
  console.log(body.slice(0, 1500));
} catch (err) {
  console.error('✗', err.message);
  process.exit(1);
}
