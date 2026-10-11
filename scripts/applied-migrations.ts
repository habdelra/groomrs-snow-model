// Prints the phase (`additive` or `removal`) of the `count` most recently
// applied migrations, newest first, one per line. Used by migrate.sh `down`.
import { withClient } from '../src/db.ts';

const count = Number(process.argv[2] ?? '1');
if (!Number.isInteger(count) || count < 1) {
  console.error(`invalid count: ${process.argv[2]}`);
  process.exit(1);
}

await withClient(async (client) => {
  const { rows } = await client.query<{ phase: string }>(
    `SELECT phase FROM (
       SELECT 'additive' AS phase, name, run_on FROM migrations
       UNION ALL
       SELECT 'removal' AS phase, name, run_on FROM migrations_removal
     ) applied
     ORDER BY run_on DESC, name DESC
     LIMIT $1`,
    [count],
  );
  for (const { phase } of rows) console.log(phase);
});
