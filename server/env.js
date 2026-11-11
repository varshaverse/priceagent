import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

const result = dotenv.config({
  path: fileURLToPath(new URL('../.env', import.meta.url))
});

if (result.error && result.error.code !== 'ENOENT') {
  throw result.error;
}
