/**
 * wiwb.mjs — test/ophaal-script voor de WIWB-API (Weer Informatie Waterbeheer).
 * Haalt neerslag op een EXACT punt op uit de KNMI-radar via de waterschappen-API.
 * De datasource `Knmi.International.Radar.Composite.Final.Reanalysis` is de
 * GAUGE-ADJUSTED radar — radar bijgeregeld met echte regenmeters = de gouden
 * meetlat. Voor een live test gebruiken we de real-time composite.
 *
 * Auth = OpenID Connect client-credentials (Client ID + Secret van de WIWB-
 * helpdesk). Draaien:
 *   WIWB_CLIENT_ID=... WIWB_CLIENT_SECRET=... node wiwb.mjs [lat] [lon] [datasource]
 */
const AUTH_URL = 'https://login.hydronet.com/auth/realms/hydronet/protocol/openid-connect/token';
const API_URL = 'https://wiwb.hydronet.com/api';

const CLIENT_ID = process.env.WIWB_CLIENT_ID;
const CLIENT_SECRET = process.env.WIWB_CLIENT_SECRET;
const lat = parseFloat(process.argv[2] ?? '52.458'); // Westzaan
const lon = parseFloat(process.argv[3] ?? '4.797');
// Real-time voor een live check; voor de gouden meetlat: ...Final.Reanalysis
const DATASOURCE = process.argv[4] ?? 'Knmi.International.Radar.Composite';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Zet WIWB_CLIENT_ID en WIWB_CLIENT_SECRET in de omgeving.');
  console.error('Voorbeeld: WIWB_CLIENT_ID=xxx WIWB_CLIENT_SECRET=yyy node wiwb.mjs');
  process.exit(1);
}

function stamp(d) {
  // yyyyMMddHHmmss in UTC.
  return d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

async function getToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const r = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('geen access_token in respons');
  return j.access_token;
}

async function getGridAtPoint(token) {
  const now = new Date();
  const start = new Date(now.getTime() - 30 * 60000); // laatste 30 min
  const e = 0.02; // klein vak rond het punt (graden)
  const req = {
    Readers: [
      {
        DataSourceCode: DATASOURCE,
        Settings: {
          StructureType: 'Grids',
          StartDate: stamp(start),
          EndDate: stamp(now),
          VariableCodes: ['P'], // neerslag
          Interval: { Type: 'Minutes', Value: 5 },
          Extent: {
            Xll: lon - e,
            Yll: lat - e,
            Xur: lon + e,
            Yur: lat + e,
            SpatialReference: { Epsg: 4326 },
          },
        },
      },
    ],
  };
  const r = await fetch(`${API_URL}/grids/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(req),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`grids/get ${r.status}: ${txt.slice(0, 400)}`);
  return JSON.parse(txt);
}

console.log(`WIWB · ${DATASOURCE} · punt ${lat},${lon}\n`);
try {
  const token = await getToken();
  console.log('✓ token verkregen');
  const data = await getGridAtPoint(token);
  console.log('✓ grid opgehaald — ruwe respons (eerste run inspecteren, dan parsen):\n');
  console.log(JSON.stringify(data, null, 2).slice(0, 2500));
} catch (err) {
  console.error('✗', err.message);
  process.exit(1);
}
