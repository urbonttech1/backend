#!/usr/bin/env node
/**
 * Carga el catálogo de ciudades desde GeoNames a la tabla `cities`.
 *
 * Uso:
 *   node scripts/import-cities.mjs              # todo el mundo, ~34.000 ciudades
 *   node scripts/import-cities.mjs US CO ES     # sólo esos países
 *
 * Variables de entorno:
 *   SUPABASE_DB_URL o DATABASE_URL — cadena de conexión a Postgres
 *
 * Se ejecuta a mano y muy de vez en cuando. Las ciudades no se mueven; lo único
 * que envejece es la población, y sólo se usa para ordenar una lista. No hay
 * ninguna razón para meter esto en el arranque del servidor ni en un cron: sería
 * añadir una dependencia de red a algo que hoy no la tiene.
 *
 * Es idempotente: vuelve a correrse encima sin duplicar nada.
 *
 * Fuente: https://download.geonames.org/export/dump/cities15000.zip
 * Licencia CC BY 4.0 — exige atribución, que va en el pie del panel.
 */

import pg from 'pg';
import { createWriteStream } from 'fs';
import { readFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const FUENTE = 'https://download.geonames.org/export/dump/cities15000.zip';

const RAW_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!RAW_URL) {
  console.error('ERROR: falta SUPABASE_DB_URL o DATABASE_URL.');
  process.exit(1);
}

/**
 * Reescribe el host directo de Supabase al pooler IPv4.
 *
 * `db.{ref}.supabase.co` sólo publica registros AAAA, así que es inalcanzable
 * desde cualquier máquina sin IPv6 — incluida ésta. El servidor hace exactamente
 * esta misma transformación en server/db/pool.ts; se repite aquí porque este
 * script es autónomo y no puede importar el módulo TypeScript.
 *
 * Si algún día cambia la de pool.ts, hay que cambiar ésta.
 */
function aPooler(url) {
  const m = url.match(/\/\/(postgres):([^@]+)@db\.([a-z0-9]+)\.supabase\.co(:\d+)?\//);
  if (!m) return url; // ya es una URL de pooler, o un formato desconocido
  const [, , password, ref] = m;
  const region = process.env.SUPABASE_REGION || 'us-west-2';
  return url
    .replace(`postgres:${password}@db.${ref}.supabase.co`, `postgres.${ref}:${password}@aws-0-${region}.pooler.supabase.com`)
    .replace(/:\d+\/postgres/, ':5432/postgres');
}

const DATABASE_URL = aPooler(RAW_URL);
if (DATABASE_URL !== RAW_URL) console.log('Host directo detectado — usando el pooler IPv4.');

/** Países a importar. Vacío = todos. */
const paises = process.argv.slice(2).map((p) => p.trim().toUpperCase()).filter(Boolean);

/**
 * Columnas del formato de GeoNames, por índice.
 * Documentado en https://download.geonames.org/export/dump/readme.txt
 */
const COL = {
  geonameId:  0,
  name:       1,
  asciiName:  2,
  lat:        4,
  lng:        5,
  countryCode: 8,
  admin1:     10,
  population: 14,
  timezone:   17,
};

async function descargar(destino) {
  console.log(`Descargando ${FUENTE} ...`);
  const res = await fetch(FUENTE);
  if (!res.ok) throw new Error(`GeoNames respondió ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destino));
}

function parsear(texto) {
  const filas = [];
  let descartadas = 0;

  for (const linea of texto.split('\n')) {
    if (!linea) continue;
    const c = linea.split('\t');

    const lat = Number(c[COL.lat]);
    const lng = Number(c[COL.lng]);
    const id  = Number(c[COL.geonameId]);

    // Una fila sin coordenadas válidas no sirve para nada aquí: el único uso de
    // esta tabla es colocar un centro en el mapa.
    if (!Number.isFinite(id) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      descartadas++;
      continue;
    }
    if (!c[COL.timezone] || !c[COL.countryCode]) { descartadas++; continue; }
    if (paises.length > 0 && !paises.includes(c[COL.countryCode])) continue;

    filas.push([
      id,
      c[COL.name],
      c[COL.asciiName] || c[COL.name],
      c[COL.countryCode],
      c[COL.admin1] || null,
      lat,
      lng,
      Number(c[COL.population]) || 0,
      c[COL.timezone],
    ]);
  }

  return { filas, descartadas };
}

/**
 * Inserta en lotes con ON CONFLICT DO UPDATE.
 *
 * En lotes porque Postgres tiene un techo de 65.535 parámetros por sentencia:
 * 34.000 filas × 9 columnas son más de 300.000, así que una sola sentencia
 * fallaría. 2.000 filas × 9 = 18.000 parámetros, bien por debajo.
 */
async function insertar(pool, filas) {
  const TAM = 2000;
  let escritas = 0;

  for (let i = 0; i < filas.length; i += TAM) {
    const lote = filas.slice(i, i + TAM);
    const valores = [];
    const marcadores = lote.map((fila, j) => {
      const base = j * 9;
      valores.push(...fila);
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9})`;
    });

    await pool.query(
      `INSERT INTO cities
         (geoname_id, name, ascii_name, country_code, admin1, lat, lng, population, timezone)
       VALUES ${marcadores.join(',')}
       ON CONFLICT (geoname_id) DO UPDATE SET
         name         = EXCLUDED.name,
         ascii_name   = EXCLUDED.ascii_name,
         country_code = EXCLUDED.country_code,
         admin1       = EXCLUDED.admin1,
         lat          = EXCLUDED.lat,
         lng          = EXCLUDED.lng,
         population   = EXCLUDED.population,
         timezone     = EXCLUDED.timezone`,
      valores,
    );

    escritas += lote.length;
    process.stdout.write(`\r  ${escritas}/${filas.length} filas`);
  }
  process.stdout.write('\n');
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'geonames-'));
  const zip = join(dir, 'cities15000.zip');
  const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    await descargar(zip);
    // unzip del sistema en vez de una dependencia nueva: este script corre a
    // mano en una máquina de desarrollo, no dentro del contenedor.
    await execFileAsync('unzip', ['-oq', zip, '-d', dir]);

    const texto = await readFile(join(dir, 'cities15000.txt'), 'utf8');
    const { filas, descartadas } = parsear(texto);

    if (filas.length === 0) {
      console.error(paises.length > 0
        ? `Ninguna ciudad para: ${paises.join(', ')}. ¿Códigos ISO correctos? (US, CO, ES...)`
        : 'El archivo no trajo ninguna fila utilizable.');
      process.exitCode = 1;
      return;
    }

    console.log(`${filas.length} ciudades a cargar${paises.length ? ` (${paises.join(', ')})` : ''}` +
                `${descartadas ? `, ${descartadas} descartadas por datos incompletos` : ''}`);

    await insertar(pool, filas);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n, COUNT(DISTINCT country_code)::int AS paises FROM cities`,
    );
    console.log(`Listo: ${rows[0].n} ciudades de ${rows[0].paises} países en la tabla.`);
  } finally {
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`Falló la importación: ${err.message}`);
  process.exit(1);
});
