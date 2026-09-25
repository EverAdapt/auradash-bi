// Build world.sqlite from the World Bank Indicators API v2 (World Development Indicators, CC BY 4.0).
// Usage: bun build-worldbank.mjs [out.sqlite]   |   node build-worldbank.mjs [out.sqlite]
import { openDb, insertMany, fetchJson } from "./sqlite.mjs";

const OUT = process.argv[2] ?? "data/world.sqlite";
const WB = "https://api.worldbank.org/v2";
const YEARS = "1960:2025";

// column in country_year  <- WDI series code. Order = column order. All series are CC BY-4.0 (checked via
// /v2/sources/2/series/{code}/metadata -> License_Type).
const INDICATORS = [
  ["population", "SP.POP.TOTL", "Population", "people", "People", 1],
  ["gdp_usd", "NY.GDP.MKTP.CD", "GDP", "current US$", "Economy", 1],
  ["gdp_per_capita_usd", "NY.GDP.PCAP.CD", "GDP per person", "current US$", "Economy", 1],
  ["life_expectancy", "SP.DYN.LE00.IN", "Life expectancy", "years", "Health", 1],
  ["infant_mortality", "SP.DYN.IMRT.IN", "Infant mortality", "per 1,000 live births", "Health", -1],
  ["health_spend_pct_gdp", "SH.XPD.CHEX.GD.ZS", "Health spending", "% of GDP", "Health", 0],
  ["fertility_rate", "SP.DYN.TFRT.IN", "Fertility rate", "births per woman", "People", 0],
  ["urban_pct", "SP.URB.TOTL.IN.ZS", "Urban population", "% of population", "People", 0],
  ["internet_pct", "IT.NET.USER.ZS", "Internet users", "% of population", "Technology", 1],
  ["electricity_access_pct", "EG.ELC.ACCS.ZS", "Access to electricity", "% of population", "Energy", 1],
  ["renewable_energy_pct", "EG.FEC.RNEW.ZS", "Renewable energy share", "% of final energy use", "Energy", 1],
  ["co2_per_capita_t", "EN.GHG.CO2.PC.CE.AR5", "CO2 per person", "tonnes CO2e per person", "Environment", -1],
  ["forest_pct", "AG.LND.FRST.ZS", "Forest cover", "% of land area", "Environment", 1],
];
// Aggregates kept (in their own table so SUM() over countries never double counts).
const AGGREGATES = {
  WLD: "world", EAS: "region", ECS: "region", LCN: "region", MEA: "region", NAC: "region", SAS: "region", SSF: "region",
  HIC: "income", UMC: "income", LMC: "income", LIC: "income",
};
const INCOME_ORDER = { LIC: 1, LMC: 2, UMC: 3, HIC: 4 };
// World Bank official names -> the name people actually type / want on a chart label.
const FRIENDLY = {
  "Bahamas, The": "Bahamas", "Brunei Darussalam": "Brunei", "Congo, Dem. Rep.": "DR Congo", "Congo, Rep.": "Congo",
  "Egypt, Arab Rep.": "Egypt", "Gambia, The": "Gambia", "Hong Kong SAR, China": "Hong Kong", "Iran, Islamic Rep.": "Iran",
  "Korea, Dem. People's Rep.": "North Korea", "Korea, Rep.": "South Korea", "Kyrgyz Republic": "Kyrgyzstan",
  "Lao PDR": "Laos", "Macao SAR, China": "Macao", "Micronesia, Fed. Sts.": "Micronesia", Naoero: "Nauru",
  "Puerto Rico (US)": "Puerto Rico", "Russian Federation": "Russia", "Sint Maarten (Dutch part)": "Sint Maarten",
  "Slovak Republic": "Slovakia", "Somalia, Fed. Rep.": "Somalia", "St. Kitts and Nevis": "Saint Kitts and Nevis",
  "St. Lucia": "Saint Lucia", "St. Martin (French part)": "Saint Martin", "St. Vincent and the Grenadines": "Saint Vincent and the Grenadines",
  "Syrian Arab Republic": "Syria", "Venezuela, RB": "Venezuela", "Viet Nam": "Vietnam",
  "Virgin Islands (U.S.)": "US Virgin Islands", "Yemen, Rep.": "Yemen",
};
// Natural Earth ADM0_A3 codes that differ from World Bank ISO3 (for choropleth joins).
export const NE_TO_WB = { SDS: "SSD", PSX: "PSE", KOS: "XKX" };

const cols = INDICATORS.map((i) => i[0]);
const DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE regions (
  region_id   TEXT PRIMARY KEY,               -- EAS, ECS, LCN, MEA, NAC, SAS, SSF
  name        TEXT NOT NULL
);
CREATE TABLE income_groups (
  income_group_id TEXT PRIMARY KEY,           -- LIC, LMC, UMC, HIC
  name            TEXT NOT NULL,
  rank            INTEGER NOT NULL            -- 1 = low ... 4 = high (for ordered axes)
);
CREATE TABLE countries (
  country_code    TEXT PRIMARY KEY,           -- ISO 3166-1 alpha-3 (World Bank uses XKX for Kosovo, CHI for Channel Islands)
  iso2_code       TEXT,
  name            TEXT NOT NULL,              -- friendly name (Russia, South Korea, Vietnam)
  official_name   TEXT NOT NULL,              -- World Bank name (Russian Federation, Korea, Rep., Viet Nam)
  region_id       TEXT NOT NULL REFERENCES regions(region_id),
  income_group_id TEXT REFERENCES income_groups(income_group_id),
  lending_type    TEXT,                       -- IBRD | IDA | Blend | Not classified
  capital_city    TEXT,
  latitude        REAL,                       -- capital city
  longitude       REAL
);
CREATE TABLE indicators (
  indicator_code  TEXT PRIMARY KEY,           -- WDI series code, e.g. SP.DYN.LE00.IN
  column_name     TEXT NOT NULL UNIQUE,       -- column in country_year / aggregate_year
  label           TEXT NOT NULL,              -- short friendly label
  name            TEXT NOT NULL,              -- official WDI name
  unit            TEXT NOT NULL,
  topic           TEXT NOT NULL,
  direction       INTEGER NOT NULL,           -- 1 higher is better, -1 lower is better, 0 neutral
  first_year      INTEGER,                    -- first year with any country value
  latest_year     INTEGER,                    -- latest year with >= 150 countries reporting ("latest" = this)
  description     TEXT,
  source          TEXT
);
CREATE TABLE country_year (
  country_code TEXT NOT NULL REFERENCES countries(country_code),
  year         INTEGER NOT NULL,
  decade       INTEGER NOT NULL,
  ${cols.map((c) => `${c} REAL`).join(",\n  ")},
  co2_total_mt REAL,                          -- derived: co2_per_capita_t * population / 1e6 (megatonnes)
  PRIMARY KEY (country_code, year)
) WITHOUT ROWID;
CREATE TABLE aggregates (
  aggregate_code TEXT PRIMARY KEY,            -- WLD, region ids, income group ids
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('world','region','income'))
);
CREATE TABLE aggregate_year (
  aggregate_code TEXT NOT NULL REFERENCES aggregates(aggregate_code),
  year           INTEGER NOT NULL,
  decade         INTEGER NOT NULL,
  ${cols.map((c) => `${c} REAL`).join(",\n  ")},
  co2_total_mt REAL,
  PRIMARY KEY (aggregate_code, year)
) WITHOUT ROWID;
CREATE INDEX idx_cy_year ON country_year(year);
CREATE INDEX idx_countries_region ON countries(region_id);

-- Latest non-null value per country for each headline measure is awkward in SQL; this view gives a
-- ready "snapshot" year row per country (most recent year that has life expectancy AND GDP per capita).
CREATE VIEW country_latest AS
SELECT cy.*, c.name, c.region_id, r.name AS region, c.income_group_id, ig.name AS income_group, ig.rank AS income_rank,
       c.latitude, c.longitude
FROM country_year cy
JOIN countries c ON c.country_code = cy.country_code
JOIN regions r ON r.region_id = c.region_id
LEFT JOIN income_groups ig ON ig.income_group_id = c.income_group_id
WHERE cy.year = (SELECT MAX(y.year) FROM country_year y
                 WHERE y.country_code = cy.country_code
                   AND y.life_expectancy IS NOT NULL AND y.gdp_per_capita_usd IS NOT NULL);

-- Flat view for single-table querying: every country-year with names attached.
CREATE VIEW country_year_facts AS
SELECT cy.*, c.name, c.region_id, r.name AS region, c.income_group_id, ig.name AS income_group, ig.rank AS income_rank,
       c.latitude, c.longitude
FROM country_year cy
JOIN countries c ON c.country_code = cy.country_code
JOIN regions r ON r.region_id = c.region_id
LEFT JOIN income_groups ig ON ig.income_group_id = c.income_group_id;
`;

const countryList = (await fetchJson(`${WB}/country?format=json&per_page=400`, "wb_countries.json"))[1];
const real = countryList.filter((c) => c.region.value.trim() !== "Aggregates");
const aggRows = countryList.filter((c) => AGGREGATES[c.id]);
const regions = new Map(), incomes = new Map();
for (const c of real) {
  regions.set(c.region.id, [c.region.id, c.region.value.trim()]); // WB names carry trailing spaces
  if (INCOME_ORDER[c.incomeLevel.id]) incomes.set(c.incomeLevel.id, [c.incomeLevel.id, c.incomeLevel.value, INCOME_ORDER[c.incomeLevel.id]]);
}
const countries = real.map((c) => [c.id, c.iso2Code, FRIENDLY[c.name] ?? c.name, c.name, c.region.id,
  INCOME_ORDER[c.incomeLevel.id] ? c.incomeLevel.id : null, c.lendingType.value, c.capitalCity || null,
  c.latitude ? Number(c.latitude) : null, c.longitude ? Number(c.longitude) : null]);
const countryCodes = new Set(countries.map((c) => c[0]));
// Income-group aggregates come back with countryiso3code "" -> resolve via their iso2-style id (XD, XM, ...).
const iso2ToCode = new Map(countryList.map((c) => [c.iso2Code, c.id]));

const indicatorRows = [];
const values = new Map(); // `${code}|${year}` -> { [column]: value }
for (const [column, code, label, unit, topic, direction] of INDICATORS) {
  const meta = (await fetchJson(`${WB}/indicator/${code}?format=json`, `wb_meta_${code}.json`))[1][0];
  indicatorRows.push([code, column, label, meta.name, unit, topic, direction, null, null, meta.sourceNote ?? null, meta.sourceOrganization ?? null]);
  const [head, rows] = await fetchJson(`${WB}/country/all/indicator/${code}?format=json&date=${YEARS}&per_page=20000`, `wb_${code}.json`);
  if (head.pages !== 1) throw new Error(`${code}: expected 1 page, got ${head.pages} (raise per_page)`);
  for (const r of rows) {
    if (r.value === null) continue;
    const key = `${r.countryiso3code || iso2ToCode.get(r.country.id)}|${r.date}`;
    if (!values.has(key)) values.set(key, {});
    values.get(key)[column] = r.value;
  }
}

const countryYear = [], aggregateYear = [];
for (const [key, v] of values) {
  const [code, y] = key.split("|");
  const year = Number(y);
  const co2Total = v.co2_per_capita_t != null && v.population != null ? (v.co2_per_capita_t * v.population) / 1e6 : null;
  const row = [code, year, Math.floor(year / 10) * 10, ...cols.map((c) => v[c] ?? null), co2Total];
  if (countryCodes.has(code)) countryYear.push(row);
  else if (AGGREGATES[code]) aggregateYear.push(row);
}
const byKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);
countryYear.sort(byKey);
aggregateYear.sort(byKey);

const db = await openDb(OUT);
db.exec(DDL);
const ph = (n) => Array(n).fill("?").join(",");
insertMany(db, "INSERT INTO regions VALUES (?,?)", [...regions.values()]);
insertMany(db, "INSERT INTO income_groups VALUES (?,?,?)", [...incomes.values()]);
insertMany(db, `INSERT INTO countries VALUES (${ph(10)})`, countries);
insertMany(db, `INSERT INTO indicators VALUES (${ph(11)})`, indicatorRows);
insertMany(db, `INSERT INTO country_year VALUES (${ph(4 + cols.length)})`, countryYear);
insertMany(db, "INSERT INTO aggregates VALUES (?,?,?)",
  aggRows.map((a) => [a.id, a.name.trim(), AGGREGATES[a.id]]));
insertMany(db, `INSERT INTO aggregate_year VALUES (${ph(4 + cols.length)})`, aggregateYear);
for (const c of cols)
  db.prepare(`UPDATE indicators SET
     first_year  = (SELECT MIN(year) FROM country_year WHERE ${c} IS NOT NULL),
     latest_year = (SELECT year FROM country_year GROUP BY year HAVING COUNT(${c}) >= 150 ORDER BY year DESC LIMIT 1)
   WHERE column_name = ?`).run(c);
// Provenance travels with the file (hidden from query candidates by the leading underscore).
db.exec("CREATE TABLE _about (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
insertMany(db, "INSERT INTO _about VALUES (?,?)", [
  ["title", "World in Numbers"], ["source", "World Bank - World Development Indicators, https://api.worldbank.org/v2 (source 2)"],
  ["license", "CC BY 4.0 - https://datacatalog.worldbank.org/search/dataset/0037712"],
  ["attribution", `Data: World Bank, World Development Indicators (retrieved ${new Date().toISOString().slice(0, 10)}), CC BY 4.0. Changes: country names shortened; decade and co2_total_mt derived.`],
  ["built_at", new Date().toISOString()],
]);
const fkErrors = db.prepare("PRAGMA foreign_key_check").all();
if (fkErrors.length) throw new Error(`FK violations: ${JSON.stringify(fkErrors.slice(0, 5))}`);
db.exec("ANALYZE; VACUUM;");
for (const t of ["regions", "income_groups", "countries", "indicators", "country_year", "aggregates", "aggregate_year"])
  console.log(t.padEnd(16), db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
db.close();
console.log("wrote", OUT);
