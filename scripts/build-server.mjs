import { build } from 'esbuild';

await build({
  entryPoints: ['server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: 'dist/server.js',
});

console.log(`Server bundled → dist/server.js`);
console.log(`Stripe keys: read from runtime env vars (STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY)`);
console.log(`Google Maps key: read from runtime env var (VITE_GOOGLE_MAPS_API_KEY)`);
