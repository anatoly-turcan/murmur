import { setTimeout as delay } from 'node:timers/promises';

import { ambientSqlite, openDatabase } from '../../../src/capabilities/sqlite.ts';
import type { Sqlite } from '../../../src/capabilities/types.ts';
import { migrate } from '../../../src/migrate.ts';

export async function writeLoop(db: Sqlite, writer: string, count: number): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    await db.transaction(async (tx) => {
      const row = await tx.get<{ total: number }>('SELECT COUNT(*) AS total FROM writes');
      await delay(1);
      await tx.run('INSERT INTO writes (writer, n, seen) VALUES (?, ?, ?)', writer, n, row?.total ?? 0);
    });
  }
}

async function run(
  file: string,
  database: ReturnType<typeof openDatabase>,
  args: readonly string[],
): Promise<void> {
  const [mode = 'write', first = '', second = '0'] = args;
  if (mode === 'migrate') {
    const report = await migrate(first, { MURMUR__CAP_SQLITE__PATH: file });
    process.stdout.write(`applied ${JSON.stringify(report.applied)}\n`);

    return;
  }

  await writeLoop(ambientSqlite(database), first, Number(second));
}

if (import.meta.main) {
  const [file = '', ...args] = process.argv.slice(2);
  const database = openDatabase(file);
  process.stdout.write('ready\n');
  await run(file, database, args);
  database.close();
}
