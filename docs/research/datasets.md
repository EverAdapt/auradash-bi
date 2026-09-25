## Recommendation: bundle **Nobel Prizes** (CC0) and **World Bank WDI** (CC BY 4.0). Drop OpenFlights.

Both SQLite files were built end to end, ran all 22 prompt queries against them, and checked that every table, column, value synonym and join in the two semantic files exists in the real databases. Only the checker itself raised a flag: it misread the single-column KPI query, which does return 67.

| | Nobel Prizes | World in Numbers (World Bank WDI) | OpenFlights (rejected) |
|---|---|---|---|
| Endpoint status | 200. 1,018 laureates, 682 prizes, covers 1901 to 2025 | 200. 295 entries (217 countries + 78 aggregates), data from 1960 to 2025, last updated 2026-07-13 | 200. 7,698 airports, 6,162 airlines, 67,663 routes |
| Licence | **CC0** ("The Services are free to use according to the Creative Commons Zero (CC0) license", Nobel terms page) | **CC BY 4.0** (Data Catalog page; each of the 13 series returns `License_Type: CC BY-4.0` from `/v2/sources/2/series/{code}/metadata`) | ODbL + DbCL (share-alike); the repo code is AGPL-3.0 |
| Freshness | 2025 laureates included | 2025 for population, GDP and urban; 2024 for most others | **Routes frozen since June 2014.** The site says "historical value only". |
| Chart strengths | Donut, histogram, stacked by decade, scatter, choropleth, **point map** (964 birth coordinates), ranked bars, KPI | **Time series**, bubble scatter (the classic GDP vs life-expectancy chart), choropleth, ranked bars, donut, histogram, KPI | Point maps only |
| Built size | 639 KB (232 KB gzipped) | 1.84 MB (1.05 MB gzipped) | n/a |

Together the two cover every chart type asked for: KPI, line / multi-line, stacked column, scatter / bubble, choropleth, point map, ranked bar, donut and histogram. They also cover different relational patterns: Nobel is a star schema with a many-to-many bridge table, and WDI is a wide time-series fact table with dimension tables. No other candidate was clearly better:
- Chinook is fake data.
- Ergast / Formula 1 is licensed non-commercial.
- MovieLens and IMDb restrict redistribution.
- Our World in Data is CC BY but flat, not relational.

OpenFlights could come back later as an optional third "maps" dataset, using airports only.

---
## Source URLs actually hit
**Nobel** (v2.1). Paginate with `limit` / `offset`; `meta.count` gives the total. The API is slow: one `limit=1100` call took 30 s, pages of 500 take about 5-8 s.
- `https://api.nobelprize.org/2.1/laureates?limit=500&offset={0,500,1000}` (3 pages, 3.9 MB)
- `https://api.nobelprize.org/2.1/nobelPrizes?limit=500&offset={0,500}` (2 pages, 0.8 MB)
- Terms: `https://www.nobelprize.org/about/terms-of-use-for-api-nobelprize-org-and-data-nobelprize-org/`. They ask apps not to alter, censor or mislead, and to cache locally rather than hit the API repeatedly; bundling a snapshot satisfies this. Photos are not CC0, so none are used.
- Fields used:
  - laureate: `id`, `knownName.en` or `orgName.en`, `fullName.en` / `nativeName`, `gender`, `birth.{date,year,place.{cityNow{en,latitude,longitude},country.en,countryNow{en,latitude,longitude},continent.en}}`, `death.{date,place}`, `founded.date`, `wikipedia.english`, `wikidata.id`
  - laureate prizes, `nobelPrizes[]`: `awardYear`, `category.en`, `portion` ("1", "1/2", "1/3", "1/4"), `sortOrder`, `motivation.en`, `prizeStatus` (received / declined / restricted), `affiliations[]{name.en, cityNow, countryNow}`, `links[rel=nobelPrize].href` (`.../nobelPrize/phy/1921`, which is where the category code comes from)
  - prize: `awardYear`, `category`, `categoryFullName`, `dateAwarded` (640 of 682), `prizeAmount`, `prizeAmountAdjusted`, `laureates[]` (missing on 49 prizes that were not awarded), `topMotivation`

**World Bank WDI**
- Countries: `https://api.worldbank.org/v2/country?format=json&per_page=400`. Drop rows whose `region.value` is `"Aggregates"`. Region names carry **trailing spaces** ("Sub-Saharan Africa "), so trim them.
- Data: `https://api.worldbank.org/v2/country/all/indicator/{CODE}?format=json&date=1960:2025&per_page=20000`. One page of 17,490 rows (about 3.5 MB, about 2 s). Row shape: `{indicator{id,value}, country{id,value}, countryiso3code, date, value}`.
- **Gotcha:** income-group aggregates come back with `countryiso3code: ""`. Resolve them through `country.id` (XD→HIC, XM→LIC, XN→LMC, XT→UMC).
- Metadata: `https://api.worldbank.org/v2/indicator/{CODE}?format=json` (name, sourceNote, sourceOrganization).
- Licence: `https://datacatalog.worldbank.org/search/dataset/0037712/World-Development-Indicators`. The `datacatalogapi` endpoint returned 429 rate limits.
- 13 series, all checked as valid and CC BY 4.0: `SP.POP.TOTL`, `NY.GDP.MKTP.CD`, `NY.GDP.PCAP.CD`, `SP.DYN.LE00.IN`, `SP.DYN.IMRT.IN`, `SH.XPD.CHEX.GD.ZS`, `SP.DYN.TFRT.IN`, `SP.URB.TOTL.IN.ZS`, `IT.NET.USER.ZS`, `EG.ELC.ACCS.ZS`, `EG.FEC.RNEW.ZS`, **`EN.GHG.CO2.PC.CE.AR5`**, `AG.LND.FRST.ZS`.
  - The classic `EN.ATM.CO2E.PC` now sits in "WDI Database Archives", so don't use it.

**OpenFlights**: `https://raw.githubusercontent.com/jpatokal/openflights/master/data/{airports,airlines,routes,countries,planes}.dat`. These are CSV files with `\N` for nulls. The last data commit to routes.dat was 2017.

## Attribution text to show in the app footer, the explorer's About panel, and inside each file
- **Nobel:** "Data: Nobel Prize Outreach, api.nobelprize.org (CC0). Not endorsed by Nobel Prize Outreach." CC0 needs no attribution; this line is a courtesy and a guard against implying endorsement.
- **World Bank:** "Data: World Bank, World Development Indicators (retrieved YYYY-MM-DD), CC BY 4.0. Changes: country names shortened; decade and co2_total_mt derived." CC BY requires stating changes.
- **Map geometry:** "Made with Natural Earth" (public domain).
- Both builds write this into an `_about(key, value)` table: title, source, license, attribution, built_at. The downloaded .sqlite therefore carries its own licence. Hide tables starting with `_` from Jev's candidates.

---
## Build scripts (tested; copy into the new repo, e.g. `scripts/datasets/`)
Folder: `scripts/datasets/`
- `sqlite.mjs`: an adapter with no dependencies.
  - `openDb(path)` uses `bun:sqlite` under Bun, otherwise `node:sqlite` `DatabaseSync` (Node 22.13 or later).
  - `insertMany(db, sql, rows)` wraps the inserts in one transaction, uses positional `?` only and maps undefined to null.
  - `fetchJson(url, cacheName)` caches responses on disk when the `CACHE_DIR` env var is set, and retries 3 times.
  - Tested on Bun 1.3.11 and Node 22.18.0. Both runtimes produced byte-identical nobel.sqlite files.
  - better-sqlite3 13.0.3 isn't needed: it builds a native module, which is painful on Windows.
- `build-nobel.mjs [out]`: fresh build takes about 15 s; offline from cache under 1 s.
  - Holds a 93-entry `COUNTRY` map from the API's `countryNow.en` to ISO3 plus a display name. It throws on any unmapped name, so a new laureate from a new country fails loudly.
  - Derived columns:
    - `age_at_award`: birthday-aware against `date_awarded`, falling back to 10 Dec
    - `birth_decade`, `decade`
    - `is_alive`, `lifespan_years`
    - `share` (a number from `portion`)
    - `prize_id` = `'{cat}-{year}'`
  - Checks foreign keys (`PRAGMA foreign_key_check`), then runs `ANALYZE; VACUUM`.
- `build-worldbank.mjs [out]`: fresh build about 18 s.
  - Wide rows are built from 13 indicator calls.
  - A `FRIENDLY` name map covers 29 countries; the official WB name is kept in `official_name`.
  - Derives `decade` and `co2_total_mt` (= `co2_per_capita_t` × population / 1e6).
  - `indicators.first_year` / `latest_year` are computed after loading; `latest_year` is the last year with at least 150 countries reporting.
  - Checks the page count, plus foreign keys, ANALYZE and VACUUM.
- Suggested `package.json`: `"data:build": "bun scripts/datasets/build-nobel.mjs public/data/nobel.sqlite && bun scripts/datasets/build-worldbank.mjs public/data/world.sqlite"`. Commit the built .sqlite files, **not** the 55 MB cache.

Outputs go to `data/`:
- `nobel.sqlite`, `world.sqlite`
- `nobel.semantic.json`, `world.semantic.json`
- `world-110m.iso3.geojson`

## Nobel DDL (exact, as built)
```sql
CREATE TABLE categories (category_id TEXT PRIMARY KEY /*phy,che,med,lit,pea,eco*/, name TEXT NOT NULL, full_name TEXT NOT NULL, first_year INTEGER NOT NULL);
CREATE TABLE countries (country_code TEXT PRIMARY KEY /*ISO3, present-day*/, name TEXT NOT NULL, continent TEXT, latitude REAL, longitude REAL);
CREATE TABLE laureates (laureate_id INTEGER PRIMARY KEY, name TEXT NOT NULL, full_name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('person','organization')), gender TEXT, birth_date TEXT, birth_year INTEGER, birth_decade INTEGER,
  birth_city TEXT, birth_country_code TEXT REFERENCES countries(country_code), birth_country_then TEXT /*Prussia, Russian Empire*/,
  birth_latitude REAL, birth_longitude REAL, death_date TEXT, death_year INTEGER, death_country_code TEXT REFERENCES countries(country_code),
  is_alive INTEGER, lifespan_years INTEGER, founded_year INTEGER, wikipedia_url TEXT, wikidata_id TEXT);
CREATE TABLE prizes (prize_id TEXT PRIMARY KEY /*phy-1921*/, award_year INTEGER NOT NULL, decade INTEGER NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(category_id), date_awarded TEXT, prize_amount_sek INTEGER, prize_amount_adj_sek INTEGER,
  laureate_count INTEGER NOT NULL, is_awarded INTEGER NOT NULL, top_motivation TEXT, UNIQUE (category_id, award_year));
CREATE TABLE awards (award_id INTEGER PRIMARY KEY, prize_id TEXT NOT NULL REFERENCES prizes(prize_id),
  laureate_id INTEGER NOT NULL REFERENCES laureates(laureate_id), portion TEXT NOT NULL, share REAL NOT NULL, sort_order INTEGER,
  motivation TEXT, prize_status TEXT, age_at_award INTEGER, UNIQUE (prize_id, laureate_id));
CREATE TABLE affiliations (affiliation_id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT, country_code TEXT REFERENCES countries(country_code),
  latitude REAL, longitude REAL, UNIQUE (name, city));
CREATE TABLE award_affiliations (award_id INTEGER NOT NULL REFERENCES awards(award_id),
  affiliation_id INTEGER NOT NULL REFERENCES affiliations(affiliation_id), PRIMARY KEY (award_id, affiliation_id));
-- indexes: awards(laureate_id), prizes(award_year), laureates(birth_country_code), award_affiliations(affiliation_id)
CREATE VIEW award_facts AS SELECT a.award_id, p.prize_id, p.award_year, p.decade, c.category_id, c.name AS category, l.laureate_id,
  l.name AS laureate, l.kind, l.gender, l.birth_year, a.age_at_award, l.birth_country_code, bc.name AS birth_country, bc.continent AS birth_continent,
  a.portion, a.share, a.motivation, a.prize_status, CAST(ROUND(p.prize_amount_adj_sek * a.share) AS INTEGER) AS prize_money_adj_sek
FROM awards a JOIN prizes p ON p.prize_id=a.prize_id JOIN categories c ON c.category_id=p.category_id
JOIN laureates l ON l.laureate_id=a.laureate_id LEFT JOIN countries bc ON bc.country_code=l.birth_country_code;
```
**Row counts:**
- categories: 6
- countries: 90
- laureates: 1,018 (990 people, 28 organisations; 67 women; 294 alive)
- prizes: 682 (49 not awarded)
- awards: 1,026 (portions 1: 362, 1/2: 337, 1/3: 249, 1/4: 78; 2 declined, 1 restricted)
- affiliations: 379
- award_affiliations: 847

**Spot checks:**
- Youngest laureate: Malala Yousafzai, 17. Oldest: John B. Goodenough, 97.
- Harvard leads affiliations with 29 prizes.
- Multiple winners: ICRC (3), Curie, Bardeen, Pauling, Sanger, Sharpless, UNHCR.

## World Bank DDL (exact, dumped from `sqlite_master`)
```sql
CREATE TABLE regions (region_id TEXT PRIMARY KEY /*EAS,ECS,LCN,MEA,NAC,SAS,SSF*/, name TEXT NOT NULL);
CREATE TABLE income_groups (income_group_id TEXT PRIMARY KEY /*LIC,LMC,UMC,HIC*/, name TEXT NOT NULL, rank INTEGER NOT NULL /*1..4*/);
CREATE TABLE countries (country_code TEXT PRIMARY KEY /*ISO3; XKX Kosovo, CHI Channel Is.*/, iso2_code TEXT, name TEXT NOT NULL /*friendly*/,
  official_name TEXT NOT NULL, region_id TEXT NOT NULL REFERENCES regions(region_id), income_group_id TEXT REFERENCES income_groups(income_group_id),
  lending_type TEXT, capital_city TEXT, latitude REAL, longitude REAL /*capital*/);
CREATE TABLE indicators (indicator_code TEXT PRIMARY KEY, column_name TEXT NOT NULL UNIQUE, label TEXT NOT NULL, name TEXT NOT NULL,
  unit TEXT NOT NULL, topic TEXT NOT NULL, direction INTEGER NOT NULL /*1 up good,-1 down good,0*/, first_year INTEGER, latest_year INTEGER,
  description TEXT, source TEXT);
CREATE TABLE country_year (country_code TEXT NOT NULL REFERENCES countries(country_code), year INTEGER NOT NULL, decade INTEGER NOT NULL,
  population REAL, gdp_usd REAL, gdp_per_capita_usd REAL, life_expectancy REAL, infant_mortality REAL, health_spend_pct_gdp REAL,
  fertility_rate REAL, urban_pct REAL, internet_pct REAL, electricity_access_pct REAL, renewable_energy_pct REAL, co2_per_capita_t REAL,
  forest_pct REAL, co2_total_mt REAL, PRIMARY KEY (country_code, year)) WITHOUT ROWID;
CREATE TABLE aggregates (aggregate_code TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('world','region','income')));
CREATE TABLE aggregate_year (aggregate_code TEXT NOT NULL REFERENCES aggregates(aggregate_code), year INTEGER NOT NULL, decade INTEGER NOT NULL,
  /* same 13 indicator columns + co2_total_mt */ PRIMARY KEY (aggregate_code, year)) WITHOUT ROWID;
-- indexes: country_year(year), countries(region_id)
-- views: country_latest (each country's latest year having both life_expectancy and gdp_per_capita; 214 rows, 2011-2024)
--        country_year_facts (country_year + name/region/income_group/rank/lat/lon)
```
**Row counts:**
- regions: 7
- income_groups: 4
- countries: 217
- indicators: 13
- country_year: 14,322 (217 × 66 years)
- aggregates: 12 (WLD, 7 regions, 4 income groups)
- aggregate_year: 792

**Latest year with at least 150 countries reporting (stored in `indicators.latest_year`):**
- 2025: population, GDP, GDP per person, urban share
- 2024: life expectancy, infant mortality, fertility, internet, electricity, CO2
- 2023: health spending, forest cover
- 2021: renewables (aggregates stop at 2020)

## Semantic layer
Full files: `data/nobel.semantic.json` and `data/world.semantic.json` (about 14 KB each). Both were checked against the databases.

**Shape of each file:** `{id, title, tagline, source, license, attribution, defaultFact, tables{ label, description, synonyms[], display, columns{ label, role, agg, unit, fk, geo, values{canonical: [synonyms]}, synonyms[], binnable } }, joins[{from,to,kind,alias}], metrics{label, sql, table, synonyms}, caveats/rules[], tryPrompts[{text, chart, sql}], morePrompts[] }`.

**Column roles:**
- Keys: `id`, `fk`
- Things to group by or label with: `dimension`, `label`
- Time: `time` with grain year or decade, plus `date`
- Numbers: `measure` with `agg` (sum / avg / max / `weighted_avg` + `weight`) and `additive`
- Maps: `geo_code` (iso3), `latitude`, `longitude`
- Other: `flag`, `text`, `url`, `hidden`, `order`

These roles give Jev its candidate lists directly: pick the measure, the group-by column, filters and time.

**Nobel synonyms:**
- Tables: laureates = "winner, people, scientists, who"; affiliations = "university, institute, lab, where they worked"
- Values: gender female = "women / woman"; category "Physiology or Medicine" = "medicine"; "Economic Sciences" = "economics"; portion "1" = "solo / unshared"; prize_status "declined" = "refused"
- Columns: age_at_award = "age, how old, youngest, oldest"; prize_amount_adj_sek = "prize money, inflation adjusted"

**Nobel metrics:**
- awards = `COUNT(*)`
- laureates = `COUNT(DISTINCT awards.laureate_id)`
- avg_age = `ROUND(AVG(age_at_award), 1)`
- prize_shares = `SUM(share)`
- women_share = `ROUND(100.0 * AVG(laureates.gender = 'female'), 1)`. Organisations have a NULL gender, so they drop out automatically.
- prize_money = `MAX(prizes.prize_amount_adj_sek)`

**World Bank synonyms:**
- Measures: population = "people, biggest"; gdp_per_capita_usd = "income, wealth, richest, standard of living"; co2_total_mt = "emissions, emitters, polluters"; fertility_rate = "children per woman"; internet_pct = "online"
- Values: region "Sub-Saharan Africa" = "africa"; "High income" = "rich / developed"; aggregates "World" = "global, globally"
- Country aliases: USA = "us, america"; UK = "britain, england"; Turkiye = "turkey"; West Bank and Gaza = "palestine"; Myanmar = "burma"

**World Bank rules** (written into the JSON so the compiler follows them):
1. Answers for the world, a region or an income group come from `aggregate_year`. Never take `AVG()` over countries: per-person and % columns are not additive.
2. For a custom group, use `SUM(x*population)/SUM(population)` for weighted_avg measures.
3. If no year is given, use `indicators.latest_year` for that measure.
4. Put GDP per person on a log scale in scatters.

## Try prompts (all SQL run against the built files; the SQL for each is in the semantic JSON)
**Nobel**
| # | Prompt | Chart | Tables | Result |
|---|---|---|---|---|
| 1 | How many women have won a Nobel Prize? | KPI | laureates | 67 |
| 2 | Which categories have the most prizes? | donut | awards⋈prizes⋈categories | 6 slices, Medicine 232 … Economics 99 |
| 3 | Women and men laureates by decade | stacked column | awards⋈prizes⋈laureates | 25 rows (decade × gender) |
| 4 | How old are laureates when they win? | histogram | awards (`(age_at_award/5)*5`) | 16 five-year bins |
| 5 | Are laureates getting older? Age at award by year | scatter, coloured by category | awards⋈prizes⋈categories⋈laureates | 995 points |
| 6 | Which countries were the most laureates born in? | choropleth | laureates⋈countries | 83 countries, USA 296, GBR 110, DEU 84 |
| 7 | Where were physics laureates born? | point map | awards⋈prizes⋈laureates | 224 points (lat/lon) |
| 8 | Top 10 universities by Nobel prizes | ranked bar | affiliations⋈award_affiliations⋈countries | Harvard 29, MIT 25, UC 23 |

More prompts: prize money over time, inflation-adjusted (line, 125 rows); who has won more than once (table, 7 rows); average age per decade (line, 13 rows).

**World Bank**
| # | Prompt | Chart | Tables | Result |
|---|---|---|---|---|
| 1 | What's the world population right now? | KPI | aggregate_year (WLD) | 8,215,424,893 (2025) |
| 2 | Life expectancy by region since 1960 | multi-line | aggregate_year⋈aggregates | 455 rows (7 regions × 65 years) |
| 3 | Do richer countries live longer? | bubble scatter (log x, size = population, colour = region) | country_year⋈countries⋈regions, 2024 | 200 countries |
| 4 | Internet users around the world | choropleth | country_year⋈countries, 2024 | 182 countries |
| 5 | Top 10 CO2 emitters | ranked bar | country_year.co2_total_mt, 2024 | China 13,125 Mt, USA 4,632, India 3,154 |
| 6 | How is the world's population split by income group? | donut | aggregate_year (kind = 'income'), 2024 | 4 slices |
| 7 | Australia vs New Zealand vs Canada: GDP per person since 1990 | multi-line | country_year⋈countries | 108 rows |
| 8 | How many children per woman across countries? | histogram | country_year (0.5-wide bins), 2024 | about 12 bins |

More prompts: renewables by region, 2000 vs 2020 (grouped bar); forest cover change since 1990 (diverging bar); lack of electricity (choropleth).

**Shape-to-chart hints for Jev's choice.** Code works out the valid candidates, then Jev picks one:
- one row with one number → KPI
- a time column plus 1 measure → line
- a time column, a category and a measure → multi-line or stacked column
- one category with 7 or fewer values and a part-of-a-whole measure → donut
- more than 7 categories → ranked bar
- 2 measures → scatter; with a third → bubble
- an iso3 column plus a measure → choropleth
- latitude and longitude → point map
- one binned measure → histogram

## Maps
The world geometry is `...\out\world-110m.iso3.geojson`. It was built from Natural Earth `ne_110m_admin_0_countries.geojson` (public domain) by keeping only the id and name, dropping Antarctica and rounding coordinates to 2 decimals.
- Size: 163 KB (50 KB gzipped), 176 features.
- `feature.id` = ADM0_A3, re-coded with the aliases `{SDS: 'SSD', PSX: 'PSE', KOS: 'XKX'}`.
- Coverage: 170 of 217 World Bank countries and 86 of 90 Nobel countries. The missing ones are microstates (BRB, FRO, LCA, SGP and so on); draw them as dots from `countries.latitude`/`longitude`.
- Don't key on NE `ISO_A3` / `ISO_N3`: they are -99 for France, Norway and Kosovo.
- Alternative: world-atlas 2.0.2 TopoJSON with ISO numeric ids, which then needs an ISO3→numeric map such as i18n-iso-countries 7.14.0 `alpha3ToNumeric`.

## Hosting on Cloudflare
- **Static asset + sql.js 1.14.2 (WASM) in the browser or a Worker.** Works for the explorer and for querying. The files are 0.23 MB and 1.05 MB gzipped.
- **D1.** Needs a SQL dump (`sqlite3 x.sqlite .dump` or Python `iterdump()`). Then strip `BEGIN TRANSACTION`/`COMMIT`, keep files under 5 GiB, use `PRAGMA defer_foreign_keys = true` if needed, and import with `npx wrangler d1 execute <db> --remote --file=x.sql`.
- **Bun** can also produce file bytes directly with `bun:sqlite` `db.serialize()`.

npm latest versions checked today: sql.js 1.14.2, better-sqlite3 13.0.3, echarts 6.1.0 (Apache-2.0), recharts 3.10.1, @observablehq/plot 0.6.17, vega-lite 6.4.3, chart.js 4.5.1, react-grid-layout 2.2.4 (MIT), world-atlas 2.0.2, i18n-iso-countries 7.14.0.

Context: shapeshift uses bun (`packageManager: bun@1.4.2`, but the machine has Bun 1.3.11), Next 16.3.5 and `@typesafe-ai/sdk ^0.6.0`.