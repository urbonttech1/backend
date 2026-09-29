/**
 * Cifrado de secretos que se guardan en `app_config` (Postgres) en vez de en
 * variables de entorno — la API key de traducción es el primer caso. AES-256-GCM
 * con el módulo `crypto` nativo de Node, sin dependencias nuevas.
 *
 * `CONFIG_ENCRYPTION_KEY` es la clave maestra: 32 bytes en base64, generada una
 * vez por entorno (`openssl rand -base64 32`) y puesta en el servidor. Sin ella
 * no se puede cifrar ni descifrar nada — a propósito no hay un valor por
 * defecto, para no terminar guardando secretos con una clave predecible.
 */
import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

function getMasterKey(): Buffer {
  const raw = process.env.CONFIG_ENCRYPTION_KEY;
  if (!raw) throw new Error('CONFIG_ENCRYPTION_KEY no está configurada en el servidor.');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('CONFIG_ENCRYPTION_KEY debe decodificar a 32 bytes (genera una con: openssl rand -base64 32).');
  }
  return key;
}

/** `iv.tag.ciphertext`, cada parte en base64. */
export function cifrar(texto: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const cifrado = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, cifrado].map((b) => b.toString('base64')).join('.');
}

export function descifrar(payload: string): string {
  const key = getMasterKey();
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Formato de secreto cifrado inválido.');

  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
