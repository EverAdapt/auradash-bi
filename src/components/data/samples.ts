/**
 * OWNER: data-engine. "Try a sample" data for the Data page: a small MySQL-dialect dump (three
 * related tables — products, stores, sales) that exercises sql-normalize.ts's dialect rules, and
 * a small standalone CSV. Both are generated deterministically (a seeded PRNG, no Date.now/Math.random)
 * so the sample is identical on every load and safe to snapshot in review.
 */

// Small deterministic PRNG (mulberry32) so "~200 rows" is stable across runs.
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Product {
  id: number
  name: string
  category: "coffee" | "tea" | "food"
  priceCents: number
}
const PRODUCTS: Product[] = [
  { id: 1, name: "House Blend", category: "coffee", priceCents: 380 },
  { id: 2, name: "Cold Brew", category: "coffee", priceCents: 450 },
  { id: 3, name: "Espresso", category: "coffee", priceCents: 320 },
  { id: 4, name: "Oat Latte", category: "coffee", priceCents: 480 },
  { id: 5, name: "Green Tea", category: "tea", priceCents: 340 },
  { id: 6, name: "Chai Latte", category: "tea", priceCents: 420 },
  { id: 7, name: "Almond Croissant", category: "food", priceCents: 395 },
  { id: 8, name: "Blueberry Muffin", category: "food", priceCents: 350 },
]

interface Store {
  id: number
  name: string
  city: string
  country: string
}
const STORES: Store[] = [
  { id: 1, name: "Riverside", city: "Portland", country: "USA" },
  { id: 2, name: "Uptown", city: "Chicago", country: "USA" },
  { id: 3, name: "Central", city: "Bristol", country: "GBR" },
  { id: 4, name: "Harbourfront", city: "Auckland", country: "NZL" },
]

const SALE_COUNT = 480
const START_DATE = Date.UTC(2025, 0, 1) // 2025-01-01, fixed (not "today") for a stable sample
const DAY_MS = 24 * 60 * 60 * 1000
const YEAR_DAYS = 365 // 2025-01-01 .. 2025-12-31: 12 full months, so month/quarter trends have data everywhere

function buildSales() {
  const rand = mulberry32(20250101)
  const rows: { id: number; storeId: number; productId: number; qty: number; soldOn: string; unitPrice: number }[] = []
  for (let i = 1; i <= SALE_COUNT; i++) {
    const store = STORES[Math.floor(rand() * STORES.length)]
    const product = PRODUCTS[Math.floor(rand() * PRODUCTS.length)]
    const qty = 1 + Math.floor(rand() * 4)
    const dayOffset = Math.floor(rand() * YEAR_DAYS)
    const soldOn = new Date(START_DATE + dayOffset * DAY_MS).toISOString().slice(0, 10)
    // Price AT THE TIME OF SALE: usually the catalog price, occasionally a small markdown or a
    // rounding-era price bump — a realistic reason the sale's own price can differ from the
    // product's current one, which is exactly why a revenue metric should read it off the sale
    // row rather than joining back to products.price_cents.
    const priceWobble = rand() < 0.12 ? (rand() < 0.5 ? 0.9 : 1.1) : 1
    const unitPrice = Math.round(product.priceCents * priceWobble) / 100
    rows.push({ id: i, storeId: store.id, productId: product.id, qty, soldOn, unitPrice })
  }
  return rows
}

function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "\\'")}'`
}

function buildDump(): string {
  const sales = buildSales()

  const productRows = PRODUCTS.map((p) => `(${p.id},${sqlQuote(p.name)},'${p.category}',${p.priceCents})`).join(",\n  ")
  const storeRows = STORES.map((s) => `(${s.id},${sqlQuote(s.name)},${sqlQuote(s.city)},'${s.country}')`).join(",\n  ")

  // Multi-row INSERTs, chunked (MySQL dumps commonly wrap at a few dozen rows per statement).
  const chunks: string[] = []
  for (let i = 0; i < sales.length; i += 40) {
    const chunk = sales.slice(i, i + 40)
    chunks.push(chunk.map((s) => `(${s.id},${s.storeId},${s.productId},${s.qty},${sqlQuote(s.soldOn)},${s.unitPrice.toFixed(2)})`).join(",\n  "))
  }

  return `/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
SET NAMES utf8mb4;

DROP TABLE IF EXISTS \`products\`;
CREATE TABLE \`products\` (
  \`product_id\` int(11) NOT NULL AUTO_INCREMENT,
  \`name\` varchar(80) NOT NULL,
  \`category\` ENUM('coffee','tea','food') NOT NULL,
  \`price_cents\` int UNSIGNED NOT NULL,
  PRIMARY KEY (\`product_id\`),
  KEY \`idx_products_category\` (\`category\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

LOCK TABLES \`products\` WRITE;
INSERT INTO \`products\` (\`product_id\`,\`name\`,\`category\`,\`price_cents\`) VALUES
  ${productRows};
UNLOCK TABLES;

DROP TABLE IF EXISTS \`stores\`;
CREATE TABLE \`stores\` (
  \`store_id\` int(11) NOT NULL AUTO_INCREMENT,
  \`name\` varchar(80) NOT NULL,
  \`city\` varchar(80) NOT NULL,
  \`country\` char(3) NOT NULL COMMENT 'ISO3',
  PRIMARY KEY (\`store_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

LOCK TABLES \`stores\` WRITE;
INSERT INTO \`stores\` (\`store_id\`,\`name\`,\`city\`,\`country\`) VALUES
  ${storeRows};
UNLOCK TABLES;

DROP TABLE IF EXISTS \`sales\`;
CREATE TABLE \`sales\` (
  \`sale_id\` int(11) NOT NULL AUTO_INCREMENT,
  \`store_id\` int(11) NOT NULL,
  \`product_id\` int(11) NOT NULL,
  \`qty\` int(11) NOT NULL,
  \`sold_on\` date NOT NULL,
  \`unit_price\` DECIMAL(6,2) NOT NULL COMMENT 'price at the time of sale',
  PRIMARY KEY (\`sale_id\`),
  KEY \`idx_sales_store\` (\`store_id\`),
  KEY \`idx_sales_product\` (\`product_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

LOCK TABLES \`sales\` WRITE;
${chunks.map((c) => `INSERT INTO \`sales\` (\`sale_id\`,\`store_id\`,\`product_id\`,\`qty\`,\`sold_on\`,\`unit_price\`) VALUES\n  ${c};`).join("\n")}
UNLOCK TABLES;
`
}

function buildCsv(): string {
  // A small, standalone CSV (not part of the dump above): one staff member per store, with a
  // start date and an hourly rate — enough columns to show numeric + text + date inference.
  const rand = mulberry32(7)
  const firstNames = ["Alex", "Sam", "Jordan", "Riley", "Casey", "Morgan", "Taylor", "Jamie"]
  const lastNames = ["Nguyen", "Patel", "Garcia", "Kim", "Brown", "Smith", "Johansson", "Rossi"]
  const rows: string[] = ["name,store,role,hourly_rate,start_date"]
  let n = 0
  for (const store of STORES) {
    const staffCount = 2 + Math.floor(rand() * 2)
    for (let i = 0; i < staffCount; i++) {
      const name = `${firstNames[n % firstNames.length]} ${lastNames[(n * 3) % lastNames.length]}`
      const role = i === 0 ? "Manager" : "Barista"
      const rate = (14 + Math.floor(rand() * 8) + (i === 0 ? 6 : 0)).toFixed(2)
      const startDay = 1 + Math.floor(rand() * 27)
      const startMonth = 1 + Math.floor(rand() * 12)
      const startDate = `2024-${String(startMonth).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`
      rows.push(`${name},${store.name},${role},${rate},${startDate}`)
      n++
    }
  }
  return rows.join("\n") + "\n"
}

export const sampleDump = {
  datasetName: "Coffee Shop (sample)",
  sqlText: buildDump(),
}

export const sampleCsv = {
  filename: "staff.csv",
  csvText: buildCsv(),
}

/** Turns the pasted-SQL sample into a File so it can go through the same import path as an upload. */
export function sampleDumpFile(): File {
  return new File([sampleDump.sqlText], "coffee_shop.sql", { type: "text/plain" })
}

export function sampleCsvFile(): File {
  return new File([sampleCsv.csvText], sampleCsv.filename, { type: "text/csv" })
}
