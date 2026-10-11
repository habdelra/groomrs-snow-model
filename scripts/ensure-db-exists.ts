// Creates the target database if it doesn't exist. Connects to the `postgres`
// maintenance database with the same connection settings as the service, so
// it works the same against the Compose Postgres or a managed one (RDS).
import { ensureDatabaseExists } from '../src/db.ts';

const created = await ensureDatabaseExists();
console.log(created ? `created database ${created}` : 'database exists');
