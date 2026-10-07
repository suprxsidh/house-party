import { startServer } from './index.ts';

const mode = process.env.HP_MODE === 'dev' ? 'dev' : 'prod';
await startServer({ port: Number(process.env.PORT) || 3000, mode });
