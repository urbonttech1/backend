# Agregar Nuevas Categorías de Imágenes

Guía completa para implementar almacenamiento de imágenes en nuevas categorías (pruebas de viaje, soporte, etc.).

---

## 🏗️ Arquitectura Actual

Todas las imágenes se guardan en **Supabase Storage**, centralizado:

| Categoría | Bucket | Tabla BD | Ruta |
|---|---|---|---|
| Avatares | `avatars` | `profiles.avatar_url` | `{uid}/avatar_*` |
| Vehículos | `avatars` | `profiles.vehicle.vehicle_photo_url` | `{uid}/vehicle_*` |
| Documentos | `chauffeur-docs` | `driver_documents` | `{uid}/{docKey}.*` |

---

## 📋 Procedimiento Completo

### Fase 1: Preparar Supabase Storage

#### **Opción A: Por Consola Supabase (Manual)** ⚠️

1. Ir a: `supabase.com` → Dashboard → Tu proyecto → Storage
2. Click **"New Bucket"**
3. Nombre: `ride-proofs` (o `support-attachments`, etc.)
4. Marcar ✅ **"Public bucket"** (si necesitas URLs públicas)
5. Click **Create**

**Tiempo:** ~2 minutos

---

#### **Opción B: Por Código (Recomendado)** ✅

Agregar a `server/db/migrations.ts`:

```typescript
// ─── Crear bucket de almacenamiento en Supabase Storage ──────────────────
// Nota: Las migraciones de SQL se ejecutan vía pool.query(), pero Supabase Storage
// se maneja por el SDK. Este script es informativo — ejecuta manualmente o usa
// scripting externo.

// Script a ejecutar una sola vez (no en migrations):
async function createStorageBuckets() {
  // Crear bucket si no existe
  const { data: buckets } = await supabaseAdmin.storage.listBuckets();
  const bucketExists = buckets?.some(b => b.name === 'ride-proofs');
  
  if (!bucketExists) {
    const { error } = await supabaseAdmin.storage.createBucket('ride-proofs', {
      public: true,
      fileSizeLimit: 10485760, // 10 MB
    });
    if (error) console.error('Failed to create bucket:', error.message);
    else console.log('Bucket ride-proofs created');
  }
}

// Llamar en server.ts al arranque (una sola vez):
createStorageBuckets().catch(console.error);
```

**Ventaja:** Se documenta en el código y es reproducible.

---

### Fase 2: Crear Tabla en BD (Por Código)

Agregar a `server/db/migrations.ts`, en la función `runMigrations()`:

```typescript
// ─── Proof of Ride Completion ─────────────────────────────────────────────
await client.query(`
  CREATE TABLE IF NOT EXISTS ride_proofs (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id       UUID        NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    driver_id     UUID        NOT NULL REFERENCES profiles(id),
    image_url     TEXT        NOT NULL,
    storage_path  TEXT        NOT NULL,
    proof_type    TEXT        NOT NULL CHECK (proof_type IN ('completion', 'damage', 'passenger_feedback')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(ride_id, proof_type)
  );
`);
CREATE INDEX IF NOT EXISTS idx_ride_proofs_ride ON ride_proofs(ride_id);
CREATE INDEX IF NOT EXISTS idx_ride_proofs_driver ON ride_proofs(driver_id);

// ─── Support Ticket Attachments ───────────────────────────────────────────
await client.query(`
  CREATE TABLE IF NOT EXISTS support_attachments (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id     UUID        NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    user_id       UUID        NOT NULL REFERENCES profiles(id),
    image_url     TEXT        NOT NULL,
    storage_path  TEXT        NOT NULL,
    file_name     TEXT,
    mime_type     TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);
CREATE INDEX IF NOT EXISTS idx_support_att_ticket ON support_attachments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_support_att_user ON support_attachments(user_id);
```

**Nota:** `migrations.ts` se ejecuta automáticamente al arrancar `server.ts`.

---

### Fase 3: Crear Endpoint en API

#### **Archivo Nuevo: `server/api/ride-proofs.ts`**

```typescript
import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../db/client';
import { requireSupabaseAuth } from './auth-middleware'; // o el middleware que uses
import { logger } from '../lib/logger';

const rideProofsRouter = Router();

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ─── POST /api/rides/proof ───────────────────────────────────────────────
rideProofsRouter.post('/:rideId/proof', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });

  const { rideId } = req.params;
  const { mimeType, base64, proofType } = req.body as {
    mimeType?: string;
    base64?: string;
    proofType?: 'completion' | 'damage' | 'passenger_feedback';
  };

  // Validar input
  if (!mimeType || !base64 || !proofType) {
    return res.status(400).json({ error: 'Missing mimeType, base64, or proofType.' });
  }

  if (!ALLOWED_MIME_TYPES.includes(mimeType.toLowerCase())) {
    return res.status(400).json({ error: 'Only JPEG, PNG, WebP allowed.' });
  }

  try {
    // Verificar que el ride pertenece al driver logueado
    const { data: ride, error: rideErr } = await supabaseAdmin
      .from('rides')
      .select('driver_id, ride_status')
      .eq('id', rideId)
      .maybeSingle();

    if (rideErr || !ride) {
      return res.status(404).json({ error: 'Ride not found.' });
    }

    if (ride.driver_id !== uid) {
      return res.status(403).json({ error: 'Cannot upload proof for another driver\'s ride.' });
    }

    // Procesar imagen
    const rawBase64 = base64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(rawBase64, 'base64');

    if (buffer.length > MAX_FILE_SIZE) {
      return res.status(400).json({ error: 'Image too large. Maximum 10 MB.' });
    }

    // Guardar en Supabase Storage
    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const storagePath = `${uid}/${rideId}/${proofType}_${Date.now()}.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('ride-proofs')
      .upload(storagePath, buffer, { contentType: mimeType, upsert: false });

    if (uploadError) {
      logger.error(`[RideProof] Storage error: ${uploadError.message}`);
      return res.status(500).json({ error: 'Upload failed.' });
    }

    // Obtener URL pública
    const { data: urlData } = supabaseAdmin.storage
      .from('ride-proofs')
      .getPublicUrl(storagePath);
    const imageUrl = urlData?.publicUrl || '';

    // Guardar en BD
    const { data: proof, error: dbError } = await supabaseAdmin
      .from('ride_proofs')
      .insert({
        ride_id: rideId,
        driver_id: uid,
        image_url: imageUrl,
        storage_path: storagePath,
        proof_type: proofType,
      })
      .select()
      .single();

    if (dbError) {
      logger.error(`[RideProof] DB error: ${dbError.message}`);
      return res.status(500).json({ error: 'Failed to save proof metadata.' });
    }

    logger.info(`[RideProof] Uploaded ${proofType} for ride ${rideId}`);
    return res.json({ success: true, proof });
  } catch (err) {
    logger.error(`[RideProof] Unexpected error: ${err}`);
    return res.status(500).json({ error: 'Upload failed.' });
  }
});

// ─── GET /api/rides/:rideId/proofs ───────────────────────────────────────
rideProofsRouter.get('/:rideId/proofs', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  const { rideId } = req.params;

  try {
    // Verificar permisos (driver o admin)
    const { data: ride } = await supabaseAdmin
      .from('rides')
      .select('driver_id')
      .eq('id', rideId)
      .maybeSingle();

    if (!ride || ride.driver_id !== uid) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const { data: proofs, error } = await supabaseAdmin
      .from('ride_proofs')
      .select('*')
      .eq('ride_id', rideId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ proofs });
  } catch (err) {
    logger.error(`[RideProof] Fetch error: ${err}`);
    return res.status(500).json({ error: 'Failed to fetch proofs.' });
  }
});

export { rideProofsRouter };
```

---

### Fase 4: Registrar Router en `server.ts`

Agregar al inicio del archivo:

```typescript
import { rideProofsRouter } from './server/api/ride-proofs';
```

Y al montaje de rutas (alrededor de línea 490):

```typescript
app.use('/api/rides', rideProofsRouter);
```

---

### Fase 5: Consumir desde Cliente

```typescript
// Frontend/Mobile
async function uploadRideProof(rideId: string, imageBase64: string, type: 'completion' | 'damage') {
  const response = await fetch(`/api/rides/${rideId}/proof`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      mimeType: 'image/jpeg',
      base64: imageBase64,
      proofType: type,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error);
  }

  const { proof } = await response.json();
  return proof.image_url; // URL pública para mostrar
}

// Uso
await uploadRideProof(rideId, canvasBase64, 'completion');
```

---

## 📊 Checklist de Implementación

### **Por Código (Recomendado):**
- [ ] Crear bucket (al arrancar, en `server.ts`)
- [ ] Agregar tabla SQL en `server/db/migrations.ts`
- [ ] Crear archivo `server/api/nueva-categoria.ts`
- [ ] Registrar router en `server.ts`
- [ ] Probar endpoint

### **Por Consola (Manual):**
- [ ] Crear bucket en Supabase Dashboard
- [ ] Agregar tabla SQL en Supabase Query Editor
- [ ] Crear archivo de API
- [ ] Registrar router
- [ ] Probar endpoint

**Recomendación:** Usa **código** para todo lo que sea posible (migraciones, buckets, endpoints) — es reproducible, versionable y funciona igual en dev/prod.

---

## 🚀 Implementar Rápido

**Resumen: qué hacer por cada componente:**

| Componente | Código | Consola | Automatizado |
|---|---|---|---|
| **Bucket Storage** | ✅ (función init) | ⚠️ Manual | Sí (al arrancar) |
| **Tabla SQL** | ✅ (`migrations.ts`) | ⚠️ Query Editor | **Sí** (automático) |
| **Endpoint API** | ✅ Obligatorio | — | **Sí** |
| **Validaciones** | ✅ Obligatorio | — | **Sí** |
| **URL pública** | ✅ En endpoint | — | **Sí** |

**Flujo ideal:**
1. Agregar tabla a `migrations.ts` → se crea automáticamente al arrancar
2. Crear `server/api/nueva-categoria.ts` → código con validaciones y lógica
3. Registrar router en `server.ts` → automático al arrancar

**Todo en código, sin ir a la consola.** La consola solo para explorar/debuggear.

---

## 💡 Ejemplos Rápidos

### Agregar categoria: Complaint Photos

```typescript
// 1. En migrations.ts:
await client.query(`
  CREATE TABLE IF NOT EXISTS complaint_photos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    complaint_id UUID NOT NULL REFERENCES complaints(id),
    user_id UUID NOT NULL,
    image_url TEXT,
    storage_path TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`);

// 2. En server/api/complaints.ts:
complaintRouter.post('/:complaintId/attach', requireSupabaseAuth, async (req, res) => {
  // ... validar usuario
  // ... guardar en storage: 'complaint-photos'/{uid}/{complaintId}/{timestamp}.jpg
  // ... guardar URL en complaint_photos
  // ... return { success: true, url }
});

// 3. En server.ts:
app.use('/api/complaints', complaintRouter);
```

**Eso es todo. Implementado.**

---

## 📝 Notas

- **RLS (Row Level Security):** Por defecto Supabase Storage es público. Si necesitas restringir, configura RLS policies en la tabla.
- **Limpieza:** Las imágenes huérfanas (referencias de BD eliminadas pero archivos en Storage) no se limpian automáticamente. Considera un cron job.
- **Caché:** Las URLs públicas pueden cachearse en CDN. Si necesitas borrar, usa `signedUrl` en lugar de `publicUrl`.





















Tipos de Imágenes por Bucket
1. AVATARES (Fotos de Perfil)
Bucket: avatars
Endpoint: POST /api/users/avatar
Ruta guardada: {uid}/avatar_{timestamp}_{randomId}.{ext}
Límite: 5 MB máx
Formatos: JPEG, PNG, WebP, HEIC
URL pública: https://supabase-url/storage/v1/object/public/avatars/{uid}/avatar_...
Guardado en BD: profiles.avatar_url

2. FOTOS DE VEHÍCULO
Bucket: avatars (mismo que avatares)
Endpoint: POST /api/users/vehicle-photo
Ruta guardada: {uid}/vehicle_{timestamp}.{ext}
Límite: 5 MB máx
Formatos: JPEG, PNG, WebP, HEIC
Guardado en BD: profiles.vehicle.vehicle_photo_url (campo JSON)
3. DOCUMENTOS DE CONDUCTOR
Bucket: chauffeur-docs
Endpoint: POST /api/chauffeur/upload-doc
Ruta guardada: {uid}/{docKey}.{ext} ⚠️ Determinística (reuploads sobrescriben)
Límite: 10 MB máx
Formatos: PDF + imágenes (JPEG, PNG, etc.)
Tipos de documento:
LICENSE (Licencia de conducir)
ID_CARD (Cédula/Pasaporte)
REGISTRATION (Registro del vehículo)
INSURANCE (Póliza de seguro)
VEHICLE_INSPECTION (Inspección técnica)
Guardado en BD: Tabla driver_documents con campos:
storage_url (URL pública)
image_url (igual que storage_url)
file_name (nombre sanitizado)
status (pending → pending_review automáticamente)
🔐 Acceso
URLs públicas — No requieren autenticación
Upload: Requiere requireSupabaseAuth (estar logueado)
Visualización: Cualquiera con la URL puede acceder
Resumen Rápido
Tipo
Bucket
Ruta
Límite
Uso
Avatar
avatars
{uid}/avatar_*
5 MB
Foto perfil usuario
Vehículo
avatars
{uid}/vehicle_*
5 MB
Foto vehículo
Documentos
chauffeur-docs
{uid}/{docKey}
10 MB
Licencia, cédula, etc.

