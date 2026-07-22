import { createClient } from '@vercel/kv';

const url = process.env.KV_REST_API_URL?.trim();
const token = process.env.KV_REST_API_TOKEN?.trim();

if (!url || !token) {
  console.log(
    JSON.stringify({
      error: 'NO_KV',
      hasUrl: !!url,
      hasToken: !!token,
      keys: Object.keys(process.env).filter(k => /KV|REDIS|UPSTASH/i.test(k)),
    })
  );
  process.exit(1);
}

const kv = createClient({ url, token });
const stored = await kv.get('app:config');
const cfg = typeof stored === 'string' ? JSON.parse(stored) : stored;
const francisco = cfg?.profesionales?.['Francisco Chibilisco'];

console.log(
  JSON.stringify(
    {
      hasConfig: !!cfg,
      feriados: cfg?.feriados ?? null,
      feriadosType: Array.isArray(cfg?.feriados) ? 'array' : typeof cfg?.feriados,
      includes_2026_07_15: Array.isArray(cfg?.feriados)
        ? cfg.feriados.includes('2026-07-15')
        : null,
      franciscoDay3: francisco?.[3] ?? francisco?.['3'] ?? null,
      franciscoDays: francisco ? Object.keys(francisco) : null,
    },
    null,
    2
  )
);
