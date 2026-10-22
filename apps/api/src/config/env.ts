import 'dotenv/config';
import { z } from 'zod';
const envSchema = z.object({ NODE_ENV: z.enum(['development', 'test', 'production']).default('development'), PORT: z.coerce.number().int().min(1).max(65535).default(4000), WEB_ORIGIN: z.string().url().default('http://localhost:5173'), DATABASE_URL: z.string().url().startsWith('postgresql://').optional(), IMAGE_STORAGE: z.enum(['local']).default('local'), IMAGE_UPLOAD_DIR: z.string().min(1).optional() });
const result = envSchema.safeParse(process.env);
if (!result.success) { console.error('Invalid environment configuration:', result.error.flatten().fieldErrors); throw new Error('Invalid environment configuration'); }
export const env = result.data;
