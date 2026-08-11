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
    freqs: [...new Set(def.tasks.map((t) => t.freq))].sort(),
    // How many measurements the Calibration Record table asks for, and which
    // columns carry the two things a technician enters against each. Counts and
    // coordinates only — never the measurements themselves, which are form
    // content and must stay out of the repository.
    calRows: def.calibration?.rows.length ?? 0,
    calCols: def.calibration
      ? { reading: def.calibration.columns.reading, pass: def.calibration.columns.pass, fail: def.calibration.columns.fail }
      : null
  });
}
const out = new URL('../test/fixtures.local.json', import.meta.url).pathname;
writeFileSync(out, JSON.stringify({ formsDir: dir, forms }, null, 2));
console.log(`wrote ${forms.length} fixtures to ${out}`);
