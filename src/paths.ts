import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repository root (one level above src/).
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
