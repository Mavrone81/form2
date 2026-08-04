// Generates test/fixtures.local.json from a forms folder.
// Usage: node scripts/build-fixtures.js "/path/to/Sample of Forms"
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkbook } from '../server/excel-parser.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/build-fixtures.js <forms-folder>');
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.xlsx') && !f.startsWith('~$')).sort();
const forms = [];
for (const [i, file] of files.entries()) {
  const def = await parseWorkbook(join(dir, file));
  forms.push({
    id: `F${String(i + 1).padStart(2, '0')}`,
    file,
    tasks: def.tasks.length,
    statusCol: def.statusColumn,
    freqs: [...new Set(def.tasks.map((t) => t.freq))].sort()
  });
}
const out = new URL('../test/fixtures.local.json', import.meta.url).pathname;
writeFileSync(out, JSON.stringify({ formsDir: dir, forms }, null, 2));
console.log(`wrote ${forms.length} fixtures to ${out}`);
