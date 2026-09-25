// Build nobel.sqlite from the Nobel Prize API v2.1 (CC0).
// Usage: bun build-nobel.mjs [out.sqlite]   |   node build-nobel.mjs [out.sqlite]
import { openDb, insertMany, fetchJson } from "./sqlite.mjs";

const OUT = process.argv[2] ?? "data/nobel.sqlite";
const API = "https://api.nobelprize.org/2.1";

// countryNow.en (as the API spells it) -> [ISO 3166-1 alpha-3, display name]. Throws on unknown names.
const COUNTRY = {
  USA: ["USA", "United States"], "United Kingdom": ["GBR", "United Kingdom"], Scotland: ["GBR", "United Kingdom"],
  "Northern Ireland": ["GBR", "United Kingdom"], Germany: ["DEU", "Germany"], France: ["FRA", "France"],
  "Guadeloupe, France": ["FRA", "France"], Switzerland: ["CHE", "Switzerland"], Sweden: ["SWE", "Sweden"],
  Japan: ["JPN", "Japan"], Russia: ["RUS", "Russia"], Italy: ["ITA", "Italy"], Canada: ["CAN", "Canada"],
  "the Netherlands": ["NLD", "Netherlands"], Poland: ["POL", "Poland"], Austria: ["AUT", "Austria"],
  Denmark: ["DNK", "Denmark"], Norway: ["NOR", "Norway"], Belgium: ["BEL", "Belgium"], Australia: ["AUS", "Australia"],
  Spain: ["ESP", "Spain"], Israel: ["ISR", "Israel"], China: ["CHN", "China"], Hungary: ["HUN", "Hungary"],
  "South Africa": ["ZAF", "South Africa"], India: ["IND", "India"], Argentina: ["ARG", "Argentina"],
  Finland: ["FIN", "Finland"], "Czech Republic": ["CZE", "Czechia"], Ireland: ["IRL", "Ireland"], Egypt: ["EGY", "Egypt"],
  Mexico: ["MEX", "Mexico"], Ukraine: ["UKR", "Ukraine"], Romania: ["ROU", "Romania"], Portugal: ["PRT", "Portugal"],
  Turkey: ["TUR", "Turkey"], Belarus: ["BLR", "Belarus"], Lithuania: ["LTU", "Lithuania"], Pakistan: ["PAK", "Pakistan"],
  "New Zealand": ["NZL", "New Zealand"], "South Korea": ["KOR", "South Korea"], Tunisia: ["TUN", "Tunisia"],
  "Saint Lucia": ["LCA", "Saint Lucia"], Iran: ["IRN", "Iran"], Chile: ["CHL", "Chile"], Greece: ["GRC", "Greece"],
  Algeria: ["DZA", "Algeria"], Venezuela: ["VEN", "Venezuela"], "East Timor": ["TLS", "Timor-Leste"],
  Liberia: ["LBR", "Liberia"], Colombia: ["COL", "Colombia"], Luxembourg: ["LUX", "Luxembourg"],
  Bangladesh: ["BGD", "Bangladesh"], Iceland: ["ISL", "Iceland"], "Bosnia and Herzegovina": ["BIH", "Bosnia and Herzegovina"],
  Vietnam: ["VNM", "Vietnam"], Philippines: ["PHL", "Philippines"], Peru: ["PER", "Peru"], Guatemala: ["GTM", "Guatemala"],
  Kenya: ["KEN", "Kenya"], Ethiopia: ["ETH", "Ethiopia"], Zimbabwe: ["ZWE", "Zimbabwe"], Gabon: ["GAB", "Gabon"],
  Lebanon: ["LBN", "Lebanon"], Myanmar: ["MMR", "Myanmar"], Cyprus: ["CYP", "Cyprus"], Madagascar: ["MDG", "Madagascar"],
  Zambia: ["ZMB", "Zambia"], "Democratic Republic of the Congo": ["COD", "DR Congo"], Bulgaria: ["BGR", "Bulgaria"],
  Slovenia: ["SVN", "Slovenia"], Serbia: ["SRB", "Serbia"], "Puerto Rico": ["PRI", "Puerto Rico"], Ghana: ["GHA", "Ghana"],
  Croatia: ["HRV", "Croatia"], Azerbaijan: ["AZE", "Azerbaijan"], "North Macedonia": ["MKD", "North Macedonia"],
  Iraq: ["IRQ", "Iraq"], "Faroe Islands (Denmark)": ["FRO", "Faroe Islands"], Jordan: ["JOR", "Jordan"],
  "Costa Rica": ["CRI", "Costa Rica"], Brazil: ["BRA", "Brazil"], Jamaica: ["JAM", "Jamaica"], Slovakia: ["SVK", "Slovakia"],
  Morocco: ["MAR", "Morocco"], Barbados: ["BRB", "Barbados"], Singapore: ["SGP", "Singapore"], Yemen: ["YEM", "Yemen"],
  "Trinidad and Tobago": ["TTO", "Trinidad and Tobago"], Latvia: ["LVA", "Latvia"], Indonesia: ["IDN", "Indonesia"],
  Nigeria: ["NGA", "Nigeria"], Taiwan: ["TWN", "Taiwan"],
};

const SHARE = { "1": 1, "1/2": 0.5, "1/3": 1 / 3, "1/4": 0.25 };
const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
const fullDate = (d) => (d && !d.includes("-00") ? d : null); // "1917-00-00" -> null
const yearOf = (d) => (d ? Number(d.slice(0, 4)) || null : null);

async function fetchAll(path, key) {
  const out = [];
  for (let offset = 0; ; offset += 500) {
    const page = await fetchJson(`${API}/${path}?limit=500&offset=${offset}`, `nobel_${path}_${offset}.json`);
    out.push(...page[key]);
    if (offset + 500 >= page.meta.count) return out;
  }
}

const DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE categories (
  category_id   TEXT PRIMARY KEY,            -- phy, che, med, lit, pea, eco
  name          TEXT NOT NULL,               -- Physics
  full_name     TEXT NOT NULL,               -- The Nobel Prize in Physics
  first_year    INTEGER NOT NULL
);
CREATE TABLE countries (                     -- present-day countries (API "countryNow"), ISO alpha-3
  country_code  TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  continent     TEXT,
  latitude      REAL,
  longitude     REAL
);
CREATE TABLE laureates (
  laureate_id        INTEGER PRIMARY KEY,
  name               TEXT NOT NULL,          -- known name, or organisation name
  full_name          TEXT,
  kind               TEXT NOT NULL CHECK (kind IN ('person','organization')),
  gender             TEXT,                   -- male | female | NULL for organisations
  birth_date         TEXT,                   -- ISO date, NULL when only the year is known
  birth_year         INTEGER,
  birth_decade       INTEGER,
  birth_city         TEXT,
  birth_country_code TEXT REFERENCES countries(country_code),
  birth_country_then TEXT,                   -- historical name, e.g. "Prussia", "Russian Empire"
  birth_latitude     REAL,
  birth_longitude    REAL,
  death_date         TEXT,
  death_year         INTEGER,
  death_country_code TEXT REFERENCES countries(country_code),
  is_alive           INTEGER,                -- 1/0 for people, NULL for organisations
  lifespan_years     INTEGER,
  founded_year       INTEGER,                -- organisations only
  wikipedia_url      TEXT,
  wikidata_id        TEXT
);
CREATE TABLE prizes (                        -- one row per category per year (incl. years not awarded)
  prize_id               TEXT PRIMARY KEY,   -- e.g. phy-1921
  award_year             INTEGER NOT NULL,
  decade                 INTEGER NOT NULL,
  category_id            TEXT NOT NULL REFERENCES categories(category_id),
  date_awarded           TEXT,
  prize_amount_sek       INTEGER,
  prize_amount_adj_sek   INTEGER,            -- inflation-adjusted SEK
  laureate_count         INTEGER NOT NULL,
  is_awarded             INTEGER NOT NULL,   -- 0 = no prize that year
  top_motivation         TEXT,
  UNIQUE (category_id, award_year)
);
CREATE TABLE awards (                        -- laureate x prize (a prize can be shared by up to 3)
  award_id       INTEGER PRIMARY KEY,
  prize_id       TEXT NOT NULL REFERENCES prizes(prize_id),
  laureate_id    INTEGER NOT NULL REFERENCES laureates(laureate_id),
  portion        TEXT NOT NULL,              -- '1', '1/2', '1/3', '1/4'
  share          REAL NOT NULL,              -- 1.0, 0.5, 0.333, 0.25
  sort_order     INTEGER,
  motivation     TEXT,
  prize_status   TEXT,                       -- received | declined | restricted
  age_at_award   INTEGER,                    -- people only
  UNIQUE (prize_id, laureate_id)
);
CREATE TABLE affiliations (                  -- university / institute at time of award
  affiliation_id INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  city           TEXT,
  country_code   TEXT REFERENCES countries(country_code),
  latitude       REAL,
  longitude      REAL,
  UNIQUE (name, city)
);
CREATE TABLE award_affiliations (
  award_id       INTEGER NOT NULL REFERENCES awards(award_id),
  affiliation_id INTEGER NOT NULL REFERENCES affiliations(affiliation_id),
  PRIMARY KEY (award_id, affiliation_id)
);
CREATE INDEX idx_awards_laureate ON awards(laureate_id);
CREATE INDEX idx_prizes_year ON prizes(award_year);
CREATE INDEX idx_laureates_birth_country ON laureates(birth_country_code);
CREATE INDEX idx_aa_affiliation ON award_affiliations(affiliation_id);

-- Flat convenience view: one row per award, everything a chart usually needs.
CREATE VIEW award_facts AS
SELECT a.award_id, p.prize_id, p.award_year, p.decade, c.category_id, c.name AS category,
       l.laureate_id, l.name AS laureate, l.kind, l.gender, l.birth_year, a.age_at_award,
       l.birth_country_code, bc.name AS birth_country, bc.continent AS birth_continent,
       a.portion, a.share, a.motivation, a.prize_status,
       CAST(ROUND(p.prize_amount_adj_sek * a.share) AS INTEGER) AS prize_money_adj_sek
FROM awards a
JOIN prizes p      ON p.prize_id = a.prize_id
JOIN categories c  ON c.category_id = p.category_id
JOIN laureates l   ON l.laureate_id = a.laureate_id
LEFT JOIN countries bc ON bc.country_code = l.birth_country_code;
`;

const laureatesRaw = await fetchAll("laureates", "laureates");
const prizesRaw = await fetchAll("nobelPrizes", "nobelPrizes");

const countries = new Map(); // code -> { row, alias }
const SUBNATIONAL = new Set(["Scotland", "Northern Ireland", "Guadeloupe, France"]);
function country(place) {
  const cn = place?.countryNow;
  if (!cn?.en) return null;
  const hit = COUNTRY[cn.en];
  if (!hit) throw new Error(`Unmapped Nobel countryNow "${cn.en}" - add it to COUNTRY`);
  const [code, name] = hit;
  const alias = SUBNATIONAL.has(cn.en); // prefer the sovereign country's own centroid over a sub-region's
  if (!countries.has(code) || (countries.get(code).alias && !alias))
    countries.set(code, { alias, row: [code, name, place.continent?.en ?? null, num(cn.latitude), num(cn.longitude)] });
  return code;
}

const catOf = (links) => links.find((l) => l.rel === "nobelPrize").href.split("/").at(-2); // .../nobelPrize/phy/1921
const categories = new Map();
const prizes = [];
for (const p of prizesRaw) {
  const cat = catOf(p.links);
  const year = Number(p.awardYear);
  if (!categories.has(cat) || categories.get(cat)[3] > year)
    categories.set(cat, [cat, p.category.en, p.categoryFullName.en, year]);
  const n = p.laureates?.length ?? 0;
  prizes.push([`${cat}-${year}`, year, Math.floor(year / 10) * 10, cat, p.dateAwarded ?? null,
    p.prizeAmount ?? null, p.prizeAmountAdjusted ?? null, n, n > 0 ? 1 : 0, p.topMotivation?.en ?? null]);
}
const prizeDate = new Map(prizes.map((r) => [r[0], r[4]]));

const laureates = [], awards = [], affiliations = new Map(), awardAff = [];
let awardId = 0;
for (const l of laureatesRaw) {
  const isOrg = !!l.orgName;
  const b = l.birth ?? null, d = l.death ?? null;
  const birthDate = fullDate(b?.date), birthYear = num(b?.year) ?? yearOf(b?.date);
  const deathDate = fullDate(d?.date), deathYear = yearOf(d?.date);
  const bPlace = b?.place, bCity = bPlace?.cityNow ?? bPlace?.city;
  laureates.push([
    Number(l.id), isOrg ? l.orgName.en : l.knownName.en, isOrg ? l.nativeName ?? null : l.fullName?.en ?? null,
    isOrg ? "organization" : "person", l.gender ?? null, birthDate, birthYear,
    birthYear ? Math.floor(birthYear / 10) * 10 : null, bCity?.en ?? null, country(bPlace),
    bPlace?.country?.en ?? null, num(bPlace?.cityNow?.latitude), num(bPlace?.cityNow?.longitude),
    deathDate, deathYear, country(d?.place), isOrg ? null : d ? 0 : 1,
    birthYear && deathYear ? deathYear - birthYear : null, isOrg ? yearOf(l.founded?.date) : null,
    l.wikipedia?.english ?? null, l.wikidata?.id ?? null,
  ]);
  if (isOrg) country(l.founded?.place);
  for (const np of l.nobelPrizes) {
    const prizeId = `${catOf(np.links)}-${np.awardYear}`;
    const awardedOn = prizeDate.get(prizeId) ?? `${np.awardYear}-12-10`;
    let age = null;
    if (!isOrg && birthYear) {
      age = Number(np.awardYear) - birthYear;
      if (birthDate && birthDate.slice(5) > awardedOn.slice(5)) age -= 1; // birthday not reached yet
    }
    awards.push([++awardId, prizeId, Number(l.id), np.portion, SHARE[np.portion], num(np.sortOrder),
      np.motivation?.en ?? null, np.prizeStatus ?? null, age]);
    for (const a of np.affiliations ?? []) {
      const city = (a.cityNow ?? a.city)?.en ?? null;
      const key = `${a.name.en}|${city}`;
      if (!affiliations.has(key))
        affiliations.set(key, [affiliations.size + 1, a.name.en, city, country(a),
          num(a.cityNow?.latitude), num(a.cityNow?.longitude)]);
      const affId = affiliations.get(key)[0];
      if (!awardAff.some((r) => r[0] === awardId && r[1] === affId)) awardAff.push([awardId, affId]);
    }
  }
}

const db = await openDb(OUT);
db.exec(DDL);
insertMany(db, "INSERT INTO categories VALUES (?,?,?,?)", [...categories.values()]);
insertMany(db, "INSERT INTO countries VALUES (?,?,?,?,?)", [...countries.values()].map((c) => c.row));
insertMany(db, `INSERT INTO laureates VALUES (${Array(21).fill("?").join(",")})`, laureates);
insertMany(db, "INSERT INTO prizes VALUES (?,?,?,?,?,?,?,?,?,?)", prizes);
insertMany(db, "INSERT INTO awards VALUES (?,?,?,?,?,?,?,?,?)", awards);
insertMany(db, "INSERT INTO affiliations VALUES (?,?,?,?,?,?)", [...affiliations.values()]);
insertMany(db, "INSERT INTO award_affiliations VALUES (?,?)", awardAff);
// Provenance travels with the file (hidden from query candidates by the leading underscore).
db.exec("CREATE TABLE _about (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
insertMany(db, "INSERT INTO _about VALUES (?,?)", [
  ["title", "Nobel Prizes"], ["source", "Nobel Prize Outreach - https://api.nobelprize.org/2.1"],
  ["license", "CC0 1.0 - https://www.nobelprize.org/about/terms-of-use-for-api-nobelprize-org-and-data-nobelprize-org/"],
  ["attribution", "Data: Nobel Prize Outreach, api.nobelprize.org (CC0). Not endorsed by Nobel Prize Outreach."],
  ["built_at", new Date().toISOString()],
]);
const fkErrors = db.prepare("PRAGMA foreign_key_check").all();
if (fkErrors.length) throw new Error(`FK violations: ${JSON.stringify(fkErrors.slice(0, 5))}`);
db.exec("ANALYZE; VACUUM;");
for (const t of ["categories", "countries", "laureates", "prizes", "awards", "affiliations", "award_affiliations"])
  console.log(t.padEnd(20), db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
db.close();
console.log("wrote", OUT);
