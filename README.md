# Plenspauze — accuratesse-logger

Meet of Plenspauze's neerslag-voorspelling klopt, **t.o.v. Buienradar als benchmark**
en tegen de **échte stationmetingen**. Draait gratis op GitHub Actions — geen server,
geen database, geen Mac die aan moet blijven. De metingen worden als databestand
teruggecommit naar de repo.

## Wat het doet
Elke ~15 minuten neemt het voor 8 NL-locaties een momentopname:
- **onze nowcast** — Open-Meteo / KNMI seamless (dezelfde bron als in de app);
- **Buienradars officiële nowcast** — het open `raintext`-endpoint dat hún app voedt;
- **de echte meting nu** — het dichtstbijzijnde KNMI/RWS-station (grondwaarheid).

`score.mjs` koppelt achteraf elke *voorspelling-voor-tijd-T* aan de *meting-op-T* en
rekent per bron uit: accuratesse, trefkans (POD) en vals-alarm (FAR), op 15/30/60/90
minuten vooruit. Zo zie je zwart-op-wit of we gelijk of beter scoren dan Buienradar.

## Eenmalig opzetten (≈5 min)
1. Maak een **nieuwe GitHub-repo** (privé mag), bijv. `plenspauze-accuracy`.
2. Push deze map erin:
   ```bash
   cd "accuracy-logger"
   git init && git add . && git commit -m "init accuracy-logger"
   git branch -M main
   git remote add origin https://github.com/<jij>/plenspauze-accuracy.git
   git push -u origin main
   ```
3. In de repo: **Settings → Actions → General → Workflow permissions** → zet op
   **"Read and write permissions"** (nodig om de data terug te committen) → Save.
4. Open de **Actions**-tab, kies **nowcast-logger**, en klik **Run workflow** om
   meteen de eerste meting te draaien. Daarna loopt-ie vanzelf elke ~15 min.

> GitHub stelt geplande runs onder drukte soms uit (echte cadans ~15–25 min) en
> **pauzeert** geplande workflows na 60 dagen zonder repo-activiteit. Voor een
> backtest van een paar dagen/weken is dat geen probleem.

## Resultaten bekijken
Laat het **een paar dagen** lopen — en het liefst door een paar natte periodes,
want zonder regen valt er weinig te scoren. Dan:
```bash
git pull           # haal de verzamelde data op
npm run score      # of: node score.mjs
```
Voorbeelduitvoer:
```
  ▸ 30 min vooruit:
    Plenspauze   ACC  92%   trefkans  78%   vals-alarm  19%   (n=420, regen-momenten=64)
    Buienradar   ACC  93%   trefkans  81%   vals-alarm  17%   (n=420, regen-momenten=64)
```
Zit de Plenspauze-rij gelijk aan of beter dan Buienradar, dan heb je een claim die
je kunt onderbouwen.

## Lokaal draaien (zonder GitHub)
```bash
node log.mjs     # één momentopname → data/JJJJ-MM-DD.ndjson
node score.mjs   # scoor wat er tot nu toe verzameld is
```

## Aanpassen
- **Locaties**: bewerk `locations.json` (naam + lat/lon).
- **Drempel/horizonnen**: `WET` en `HORIZONS` boven in `score.mjs`.
- **Frequentie**: de `cron` in `.github/workflows/log.yml` (denk aan GitHubs limieten).

## Geen data-kwijt-risico
Elke run is een losse append; bij overlappende runs rebaset de Action vóór de push.
De ruwe NDJSON blijft staan, dus je kunt later ook andere metrieken berekenen
(bijv. exacte regen-begin-tijd of mm-afwijking) zonder opnieuw te verzamelen.
