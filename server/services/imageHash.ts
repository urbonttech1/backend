/**
 * Huella de una foto para reconocerla aunque la hayan recomprimido o
 * redimensionado (dHash): se reduce a 9×8 en grises y cada bit dice si un píxel
 * es más claro que el de su derecha. Dos huellas a pocos bits de distancia son
 * la misma imagen. Ver `compararConAnteriores` en `vehicleInspection.ts`.
 */
import sharp from 'sharp';

export async function huellaDeImagen(imagen: Buffer): Promise<string> {
  const pixeles = await sharp(imagen)
    .rotate()
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer();

  let huella = '';
  for (let fila = 0; fila < 8; fila += 1) {
    let byte = 0;
    for (let col = 0; col < 8; col += 1) {
      const i = fila * 9 + col;
      byte = (byte << 1) | (pixeles[i] > pixeles[i + 1] ? 1 : 0);
    }
    huella += byte.toString(16).padStart(2, '0');
  }
  return huella;
}
