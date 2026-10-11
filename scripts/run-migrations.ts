// Run database migrations and exit.
import { migrateToLatest } from '../src/db.ts';

await migrateToLatest({ log: true });
console.log('Migrations complete.');
