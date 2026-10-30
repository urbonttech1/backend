/**
 * Aplica las migraciones sin arrancar el servidor: `pnpm migrate`.
 *
 * El servidor ya las corre al arrancar, así que un despliegue las aplica solo.
 * Esto es para los casos en que el esquema tiene que estar listo ANTES —probar
 * en local contra la base, o adelantar unas columnas nuevas sin desplegar—, y
 * para no tener que arrancar el servidor entero sólo para eso.
 *
 * Es seguro repetirlo: cada sentencia de `migrations.ts` es idempotente
 * (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`), así que correrlo dos veces no
 * cambia nada la segunda. Lee la conexión de `SUPABASE_DB_URL`, igual que el
 * servidor; el `--env-file=.env` del script del package.json la carga.
 *
 * Sale con 1 si algo falla, para que un CI lo note: aquí sí es un error, a
 * diferencia del arranque, donde se sirve con el esquema viejo antes que caerse.
 */
import { runMigrations } from '../server/db/migrations';
import { pool } from '../server/db/pool';
import { logger } from '../server/lib/logger';

async function main(): Promise<void> {
  const empezo = Date.now();
  await runMigrations();
  // Sin esto, PostgREST sigue sirviendo con su caché anterior y las columnas
  // nuevas no se ven hasta que el servidor arranque. Es lo mismo que hace
  // `server.ts` justo después de migrar.
  await pool.query("NOTIFY pgrst, 'reload schema'").catch(() => {});
  logger.info(`[Migrate] Listo en ${((Date.now() - empezo) / 1000).toFixed(1)} s.`);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    logger.error(`[Migrate] Falló: ${err instanceof Error ? err.message : String(err)}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
