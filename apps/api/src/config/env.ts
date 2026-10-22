import 'dotenv/config';
import { parseApiEnvironment } from './env-validation.js';

const result = parseApiEnvironment(process.env);
if (!result.success) {
  const invalidFields = [...new Set(result.error.issues.map((issue) => issue.path[0]))];
  console.error('Invalid environment configuration fields:', invalidFields);
  throw new Error('Invalid environment configuration.');
}
export const env = result.data;
