import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../db/client';
import { pool } from '../db/pool';
import { requireSupabaseAuth } from '../middleware';
import { logger } from '../lib/logger';
import {
  recalcularVerificacion,
  ACCEPTED_DOC_KEYS,
  REQUIRED_DOC_KEYS,
  docMeta,
} from '../services/driverVerification';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export const chauffeurDocsRouter = Router();

// REQUIRED_DOC_KEYS y DocKey viven en services/driverVerification para que la
// lista de documentos exigidos sea una sola en todo el backend: el panel de
// admin comparaba contra un total de 11 filas en vez de contra estos tipos.

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
];

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// ─────────────────────────────────────────────────────────────────────────────
// Schema self-healing — Uber-style: ensure the driver_documents table has
// all required columns and the unique index that makes per-driver-per-docKey
// upserts work correctly.  Called on first DB failure so cold Supabase
// instances (schema-only setup, no pool migrations) auto-repair.
// ─────────────────────────────────────────────────────────────────────────────
async function ensureDriverDocumentsSchema(): Promise<void> {
  try {
    // Full table creation (safe on existing tables)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS driver_documents (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id     UUID REFERENCES profiles(id) ON DELETE CASCADE,
        doc_key       VARCHAR(100) NOT NULL,
        document_type VARCHAR(100),
        status        VARCHAR(30)  NOT NULL DEFAULT 'pending',
        storage_url   TEXT,
        image_url     TEXT,
        file_name     VARCHAR(255),
        driver_name   VARCHAR(255),
        expiry_date   DATE,
        notified_30d  BOOLEAN DEFAULT false,
        notified_7d   BOOLEAN DEFAULT false,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    // Additive columns (safe on instances with the old schema)
    const addCols = [
      `ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS doc_key       VARCHAR(100)`,
      `ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS document_type VARCHAR(100)`,
      `ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS image_url     TEXT`,
      `ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS storage_url   TEXT`,
      `ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS file_name     VARCHAR(255)`,
      `ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS driver_name   VARCHAR(255)`,
      `ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS expiry_date   DATE`,
      `ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS notified_30d  BOOLEAN DEFAULT false`,
      `ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS notified_7d   BOOLEAN DEFAULT false`,
    ];
    for (const sql of addCols) {
      try { await pool.query(sql); } catch { /* column already exists */ }
    }

    // Named UNIQUE constraint — Supabase PostgREST needs this to honour
    // onConflict: 'driver_id,doc_key'.  DO...END makes it idempotent.
    await pool.query(`
      DO $ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'driver_documents_driver_doc_key_unique'
            AND conrelid = 'driver_documents'::regclass
        ) THEN
          ALTER TABLE driver_documents
            ADD CONSTRAINT driver_documents_driver_doc_key_unique
            UNIQUE (driver_id, doc_key);
        END IF;
      END $
    `);
  } catch {
    // Pool unavailable (SUPABASE_DB_URL not set) — can't run DDL.
    // The caller will log and fall back gracefully.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Uber-style upsert: save one authoritative record per (driver, docKey).
// Re-uploads replace the existing record and reset status to 'pending' so
// admins re-review the new file.  No id is sent — let the DB generate it on
// INSERT; the UNIQUE index handles the update path.
// ─────────────────────────────────────────────────────────────────────────────
interface DocRecord {
  driver_id:     string;
  doc_key:       string;
  document_type: string;
  storage_url:   string;
  image_url:     string;
  file_name:     string;
  driver_name:   string;
  status:        string;
  updated_at:    string;
  /** Vencimiento del documento, `YYYY-MM-DD`, o null si no aplica. */
  expiry_date?:  string | null;
}

/**
 * Fecha de vencimiento válida, o `null`.
 *
 * POR QUÉ EXISTE — la app lleva enviando `expiryDate` desde siempre y el servidor
 * no lo leía. No era sólo un dato perdido: `driver_documents.expiry_date` alimenta
 * el cron de `jobs/cron.ts`, que avisa al conductor a 30 y a 7 días del
 * vencimiento y lo suspende cuando el documento caduca. Como ninguna fila tenía
 * fecha, ese cron nunca encontró nada — un control de vencimientos completo,
 * corriendo a diario, mirando una columna vacía.
 *
 * Una fecha inválida NO tumba la subida: el documento importa más que su fecha, y
 * rechazar el archivo entero por un formato raro sería peor que guardarlo sin ella.
 */
function fechaVencimientoValida(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  // Se comprueba el ida y vuelta: '2026-02-31' pasa el regex pero no es una fecha.
  if (d.toISOString().slice(0, 10) !== s) return null;
  return s;
}

/** ¿Esa fecha ya pasó? Se compara por día, en UTC. */
function yaVencio(fecha: string): boolean {
  return fecha < new Date().toISOString().slice(0, 10);
}

async function upsertDocRecord(record: DocRecord): Promise<{ error: string | null }> {
  // La fecha sólo viaja si la hay. Mandarla como null la borraría en cada
  // re-subida sin fecha, que es justo lo contrario de lo que se quiere.
  // Y cuando sí hay fecha nueva, los avisos vuelven a cero: un documento
  // renovado tiene que poder avisar otra vez a 30 y a 7 días.
  const { expiry_date, ...base } = record;
  const payload: Record<string, unknown> = expiry_date
    ? { ...base, expiry_date, notified_30d: false, notified_7d: false }
    : { ...base };

  // Attempt 1 — supabaseAdmin PostgREST (works when unique index exists)
  const { error: e1 } = await supabaseAdmin
    .from('driver_documents')
    .upsert(payload, { onConflict: 'driver_id,doc_key', ignoreDuplicates: false });

  if (!e1) return { error: null };

  logger.warn(`[DocUpsert] supabaseAdmin failed (${e1.message}) — attempting schema repair`);

  // Attempt 2 — auto-repair schema (adds missing columns + unique index) then retry
  await ensureDriverDocumentsSchema();

  const { error: e2 } = await supabaseAdmin
    .from('driver_documents')
    .upsert(payload, { onConflict: 'driver_id,doc_key', ignoreDuplicates: false });

  if (!e2) return { error: null };

  logger.warn(`[DocUpsert] PostgREST retry failed (${e2.message}) — falling back to pool SQL`);

  // Attempt 3 — direct SQL via pool (bypasses PostgREST entirely)
  try {
    await pool.query(
      `INSERT INTO driver_documents
         (driver_id, doc_key, document_type, storage_url, image_url, file_name, driver_name,
          status, updated_at, expiry_date, notified_30d, notified_7d)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,false)
       ON CONFLICT (driver_id, doc_key)
       DO UPDATE SET
         document_type = EXCLUDED.document_type,
         storage_url   = EXCLUDED.storage_url,
         image_url     = EXCLUDED.image_url,
         file_name     = EXCLUDED.file_name,
         driver_name   = EXCLUDED.driver_name,
         status        = 'pending',
         updated_at    = EXCLUDED.updated_at,
         -- Una fecha nueva sustituye a la vieja; si la subida no trae fecha se
         -- conserva la que hubiera, para no borrar un vencimiento al re-subir.
         expiry_date   = COALESCE(EXCLUDED.expiry_date, driver_documents.expiry_date),
         -- Documento renovado, avisos a cero: si no, un documento que ya avisó a
         -- 30 y 7 días no volvería a avisar nunca tras renovarse.
         notified_30d  = false,
         notified_7d   = false`,
      [
        record.driver_id, record.doc_key, record.document_type,
        record.storage_url, record.image_url, record.file_name,
        record.driver_name, record.status, record.updated_at,
        record.expiry_date ?? null,
      ],
    );
    return { error: null };
  } catch (poolErr) {
    return { error: errMsg(poolErr) };
  }
}

/* ──────────────────────────────────────────────
   GET /api/chauffeur/required-docs
   Público: es un catálogo, no lleva datos de nadie. Lo pide también el signup web.

   Existe porque hasta ahora cada pantalla de la app traía su propia lista fija, y
   las dos no coincidían: el registro pedía once documentos y Cuenta → Documentos
   otros once, con seis claves en común. El aviso del panel decía «upload all 11
   required documents» sin poder decir cuáles.

   Con esto la lista es una sola y vive donde se puede cambiar sin publicar una
   versión de la app.
────────────────────────────────────────────── */
chauffeurDocsRouter.get('/required-docs', (_req: Request, res: Response) => {
  res.json({
    // Hoy una sola lista para todos. El día que se decida qué se pide fuera de
    // EE. UU., este endpoint pasa a responder por país y la app no cambia: ya
    // estará leyendo de aquí. `country` viaja desde el principio para eso.
    country: 'US',
    docs: REQUIRED_DOC_KEYS.map((k) => docMeta(k)),
    totalRequired: REQUIRED_DOC_KEYS.length,
    // Todo lo que el servidor acepta guardar, más allá de lo que exige. Incluye
    // los permisos de condado y los papeles de empresa del esquema anterior.
    acceptedDocKeys: ACCEPTED_DOC_KEYS,
    // Los límites que la app necesita para comprimir ANTES de subir, en vez de
    // descubrirlos con un error a mitad de una carga de once archivos.
    acceptedMimeTypes: ALLOWED_MIME_TYPES,
    maxFileBytes:  MAX_FILE_SIZE_BYTES,
    maxBatchBytes: 50 * 1024 * 1024,
  });
});

/* ──────────────────────────────────────────────
   POST /api/chauffeur/upload-doc
   Body: { docKey, fileName, mimeType, base64 }
   Uploads ONE document.  Uber-style: stable storage path so re-uploads
   replace the previous file rather than accumulating orphaned copies.
────────────────────────────────────────────── */
chauffeurDocsRouter.post('/upload-doc', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid  = req.supabaseUid;
  const role = req.supabaseRole;

  if (!uid)             return res.status(401).json({ error: 'Unauthorized.',                errorCode: 'UNAUTHORIZED'  });
  if (role !== 'chauffeur' && role !== 'driver') return res.status(403).json({ error: 'Chauffeur account required.', errorCode: 'ACCESS_DENIED' });

  const { docKey, fileName, mimeType, base64, expiryDate } = req.body as {
    docKey?: string; fileName?: string; mimeType?: string; base64?: string; expiryDate?: string;
  };

  // Decir cuál de los cuatro falta: 'Missing required fields' obligaba a
  // adivinar, y el que falla casi siempre es el archivo.
  const faltaDoc = !docKey ? 'docKey' : !fileName ? 'fileName' : !mimeType ? 'mimeType' : !base64 ? 'base64' : null;
  if (faltaDoc)
    return res.status(400).json({
      error: faltaDoc === 'base64'
        ? 'The file did not reach us. Please pick the file again.'
        : `Missing required field: ${faltaDoc}.`,
      errorCode: 'MISSING_FIELDS',
      field: faltaDoc,
    });

  if (!ACCEPTED_DOC_KEYS.includes(docKey))
    return res.status(400).json({
      error: `"${docKey}" is not a document we ask for. Please upload it in the matching slot.`,
      errorCode: 'INVALID_DOC_KEY',
      field: 'docKey',
      acceptedDocKeys: ACCEPTED_DOC_KEYS,
    });

  if (!ALLOWED_MIME_TYPES.includes(mimeType.toLowerCase()))
    return res.status(400).json({
      error: 'That file type is not supported. Upload a PDF or a photo (JPG, PNG, WEBP or HEIC).',
      errorCode: 'INVALID_MIME_TYPE',
      field: 'file',
      allowedTypes: ALLOWED_MIME_TYPES,
    });

  // Una fecha ilegible se ignora y el documento se guarda igual; una ya vencida se
  // rechaza, porque aceptarla sería registrar como válido algo que no lo es.
  const vencimiento = fechaVencimientoValida(expiryDate);
  if (vencimiento && yaVencio(vencimiento))
    return res.status(400).json({
      error: `That document expired on ${vencimiento}. Upload a current one.`,
      errorCode: 'DOCUMENT_EXPIRED',
      field: 'expiryDate',
      expiryDate: vencimiento,
    });

  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);

  try {
    const rawBase64 = base64.replace(/^data:[^;]+;base64,/, '');
    const buffer    = Buffer.from(rawBase64, 'base64');

    if (buffer.length > MAX_FILE_SIZE_BYTES)
      return res.status(400).json({
        error: `That file is ${(buffer.length / 1048576).toFixed(1)} MB. Please upload a file under 10 MB — a photo taken in "medium" quality usually fits.`,
        errorCode: 'FILE_TOO_LARGE',
        field: 'file',
        maxBytes: MAX_FILE_SIZE_BYTES,
        actualBytes: buffer.length,
      });

    // Stable storage path: re-uploads overwrite the previous file (Uber-style).
    // Format: <uid>/<docKey>.<ext>  — no timestamp, deterministic per driver+doc.
    const ext         = (safeFileName.split('.').pop() || mimeType.split('/')[1] || 'bin').replace('jpeg', 'jpg');
    const storagePath = `${uid}/${docKey}.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('chauffeur-docs')
      .upload(storagePath, buffer, { contentType: mimeType, upsert: true });

    if (uploadError) {
      logger.error(`[DocUpload] Storage error for ${docKey}: ${uploadError.message}`);
      return res.status(500).json({
        error: 'We could not store your document. Check your connection and upload it again.',
        errorCode: 'UPLOAD_FAILED',
        field: 'file',
        action: 'retry',
      });
    }

    const { data: urlData } = supabaseAdmin.storage.from('chauffeur-docs').getPublicUrl(storagePath);
    const storageUrl = urlData?.publicUrl || storagePath;

    const { data: profileData } = await supabaseAdmin
      .from('profiles').select('first_name, last_name').eq('id', uid).maybeSingle();
    const driverName = profileData
      ? `${profileData.first_name || ''} ${profileData.last_name || ''}`.trim()
      : '';

    const { error: dbErr } = await upsertDocRecord({
      driver_id:     uid,
      doc_key:       docKey,
      document_type: docKey,
      storage_url:   storageUrl,
      image_url:     storageUrl,
      file_name:     safeFileName,
      driver_name:   driverName,
      status:        'pending',
      updated_at:    new Date().toISOString(),
      expiry_date:   vencimiento,
    });

    if (dbErr) {
      logger.error(`[DocUpload] DB write failed for ${docKey}: ${dbErr}`);
      // Storage file is saved — the document exists but metadata couldn't persist.
      // Return a specific error so the client shows a retry prompt.
      return res.status(500).json({
        error: 'Document uploaded but could not be recorded. Please try uploading again.',
        errorCode: 'DB_WRITE_FAILED',
      });
    }

    logger.info(`[DocUpload] ${docKey} saved for driver ${uid}`);

    // El estado del conductor lo decide `recalcularVerificacion`: antes se
    // marcaba `pending_review` en cuanto estaban los once archivos, sin mirar si
    // alguno venía rechazado ni si había vehículo.
    const verificacion = await recalcularVerificacion(uid);

    return res.json({
      success: true,
      storageUrl,
      docKey,
      // Se devuelve lo que quedó guardado, no lo que llegó: si la fecha venía en
      // un formato que no se pudo leer, aquí llega `null` y la app se entera.
      expiryDate: vencimiento,
      verificationStatus: verificacion.status,
      missingDocs: verificacion.missingDocs,
    });
  } catch (err) {
    logger.error(`[DocUpload] Unexpected error: ${errMsg(err)}`);
    return res.status(500).json({
      error: 'Something went wrong while uploading your document. Please try again, or contact support@urbont.com if it keeps failing.',
      errorCode: 'UPLOAD_FAILED',
      action: 'retry',
    });
  }
});

/**
 * Cuerpo común de `/submit` y `/submit-documents`.
 *
 * Las dos rutas hacían casi lo mismo con el código duplicado, y la única
 * diferencia real es que `submit-documents` corta con 400 si faltan documentos.
 * Se mantienen las dos —hay APK en la calle usando cada una— pero con una sola
 * implementación detrás.
 *
 * La respuesta lleva la unión de los campos que devolvía cada una. Añadir campos
 * no rompe a nadie; quitarlos sí, así que no se quita ninguno.
 */
async function responderEstadoAlta(
  uid: string,
  res: Response,
  opciones: { exigirCompletos: boolean; etiqueta: string },
) {
  try {
    const verificacion = await recalcularVerificacion(uid);

    if (opciones.exigirCompletos && verificacion.missingDocs.length > 0) {
      return res.status(400).json({
        error: `Missing documents: ${verificacion.missingDocs.map((k) => docMeta(k).label).join(', ')}`,
        errorCode: 'INCOMPLETE_DOCUMENTS',
        missingDocs: verificacion.missingDocs,
        // Con la etiqueta legible al lado, la app puede listar lo que falta sin
        // llevar su propio diccionario de claves internas.
        missingDocsDetail: verificacion.missingDocs.map((k) => docMeta(k)),
      });
    }

    return res.json({
      success: true,
      status: verificacion.status,
      verificationStatus: verificacion.status,
      missingDocs: verificacion.missingDocs,
      missingDocsDetail: verificacion.missingDocs.map((k) => docMeta(k)),
      rejectedDocs: verificacion.rejectedDocs,
      hasVehicle: verificacion.hasVehicle,
      reason: verificacion.reason,
    });
  } catch (err) {
    logger.error(`[${opciones.etiqueta}] Error: ${errMsg(err)}`);
    return res.status(500).json({
      error: 'We could not submit your application for review. Your documents are saved — please try again in a moment.',
      errorCode: 'SUBMIT_FAILED',
      action: 'retry',
    });
  }
}

/* ──────────────────────────────────────────────
   POST /api/chauffeur/submit-documents
   Validates all required docs are present, then marks as pending_review.

   OBSOLETA en favor de /submit, que hace lo mismo sin exigir que estén todos.
   Se mantiene porque hay APK publicados que la llaman.
────────────────────────────────────────────── */
chauffeurDocsRouter.post('/submit-documents', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid  = req.supabaseUid;
  const role = req.supabaseRole;

  if (!uid)             return res.status(401).json({ error: 'Unauthorized.',                errorCode: 'UNAUTHORIZED'  });
  if (role !== 'chauffeur' && role !== 'driver') return res.status(403).json({ error: 'Chauffeur account required.', errorCode: 'ACCESS_DENIED' });

  return responderEstadoAlta(uid, res, { exigirCompletos: true, etiqueta: 'DocSubmit' });
});

/* ──────────────────────────────────────────────
   GET /api/chauffeur/verification-status
   Returns driver verification status + all uploaded docs map.
────────────────────────────────────────────── */
chauffeurDocsRouter.get('/verification-status', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid  = req.supabaseUid;
  const role = req.supabaseRole;

  if (!uid)             return res.status(401).json({ error: 'Unauthorized.',                errorCode: 'UNAUTHORIZED'  });
  if (role !== 'chauffeur' && role !== 'driver') return res.status(403).json({ error: 'Chauffeur account required.', errorCode: 'ACCESS_DENIED' });

  try {
    const [{ data: profile }, { data: docs, error: docsErr }] = await Promise.all([
      supabaseAdmin.from('profiles')
        .select('verification_status, rejection_reason, operating_city')
        .eq('id', uid).maybeSingle(),
      supabaseAdmin.from('driver_documents')
        .select('doc_key, status, storage_url, image_url, file_name, created_at, updated_at')
        .eq('driver_id', uid),
    ]);

    if (docsErr) {
      logger.warn(`[VerifStatus] Could not fetch docs for ${uid}: ${docsErr.message}`);
    }

    // Build uploadedDocs map — most recent record per doc_key wins
    // (safe even if duplicates exist from before the unique index was added)
    const uploadedDocs: Record<string, {
      status: string; url: string; fileName: string;
      uploadedAt: string; updatedAt?: string;
    }> = {};

    for (const doc of (docs || []) as Array<{
      doc_key: string; status: string; storage_url: string;
      image_url: string; file_name: string; created_at: string; updated_at: string;
    }>) {
      const existing = uploadedDocs[doc.doc_key];
      if (!existing || doc.updated_at > existing.updatedAt!) {
        uploadedDocs[doc.doc_key] = {
          status:     doc.status,
          url:        doc.storage_url || doc.image_url,
          fileName:   doc.file_name,
          uploadedAt: doc.created_at,
          updatedAt:  doc.updated_at,
        };
      }
    }

    return res.json({
      verificationStatus: (profile?.verification_status as string) || 'pending_documents',
      rejectionReason:    profile?.rejection_reason  || null,
      operatingCity:      profile?.operating_city    || null,
      uploadedDocs,
    });
  } catch (err) {
    logger.error(`[VerifStatus] Error: ${errMsg(err)}`);
    return res.status(500).json({
      error: 'We could not load your application status right now. Pull to refresh in a moment.',
      errorCode: 'STATUS_UNAVAILABLE',
      action: 'retry',
    });
  }
});

/* ──────────────────────────────────────────────
   POST /api/chauffeur/set-vehicle
────────────────────────────────────────────── */
chauffeurDocsRouter.post('/set-vehicle', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid  = req.supabaseUid;
  const role = req.supabaseRole;

  if (!uid)             return res.status(401).json({ error: 'Unauthorized.',                errorCode: 'UNAUTHORIZED'  });
  if (role !== 'chauffeur' && role !== 'driver') return res.status(403).json({ error: 'Chauffeur account required.', errorCode: 'ACCESS_DENIED' });

  const { make, model, year, color, plate, category, vehicle_photo_url } = req.body as {
    make?: string; model?: string; year?: string; color?: string; plate?: string;
    category?: string; vehicle_photo_url?: string;
  };

  // Se devuelve EL campo que falta, no la lista entera: con un `MISSING_FIELDS`
  // pelado la app no podía marcar cuál de los cinco estaba vacío.
  const camposVehiculo: Array<[string, string | undefined, string]> = [
    ['make',  make,  'vehicle make'],
    ['model', model, 'vehicle model'],
    ['year',  year,  'vehicle year'],
    ['color', color, 'vehicle color'],
    ['plate', plate, 'license plate'],
  ];
  const faltante = camposVehiculo.find(([, valor]) => !valor || !String(valor).trim());
  if (faltante) {
    const [campo, , etiqueta] = faltante;
    return res.status(400).json({
      error: `Enter your ${etiqueta} to continue.`,
      errorCode: 'MISSING_FIELDS',
      field: campo,
      missingFields: camposVehiculo.filter(([, v]) => !v || !String(v).trim()).map(([c]) => c),
    });
  }

  const anio = parseInt(String(year).trim(), 10);
  const anioMax = new Date().getFullYear() + 1;
  if (!Number.isFinite(anio) || anio < 1980 || anio > anioMax) {
    return res.status(400).json({
      error: `Enter a vehicle year between 1980 and ${anioMax}.`,
      errorCode: 'INVALID_YEAR',
      field: 'year',
    });
  }

  try {
    const { data: existingRow } = await supabaseAdmin
      .from('profiles').select('vehicle').eq('id', uid).single();
    const existingVehicle = (existingRow?.vehicle as Record<string, unknown>) || {};

    const vehicle = {
      ...existingVehicle,
      make:  make.trim(),
      model: model.trim(),
      year:  year.trim(),
      color: color.trim(),
      plate: plate.trim().toUpperCase(),
      ...(category          ? { category: category.trim() }      : {}),
      ...(vehicle_photo_url ? { vehicle_photo_url }               : {}),
    };

    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ vehicle, updated_at: new Date().toISOString() })
      .eq('id', uid);

    if (error) {
      logger.error(`[SetVehicle] DB error: ${error.message}`);
      return res.status(500).json({
        error: 'We could not save your vehicle details. Please try again in a moment.',
        errorCode: 'VEHICLE_SAVE_FAILED',
        action: 'retry',
      });
    }

    // El vehículo es condición de aprobación, así que registrarlo puede ser lo
    // último que le faltaba al conductor para quedar aprobado.
    const verificacion = await recalcularVerificacion(uid);

    return res.json({ success: true, vehicle, verificationStatus: verificacion.status });
  } catch (err) {
    logger.error(`[SetVehicle] Error: ${errMsg(err)}`);
    return res.status(500).json({
      error: 'Something went wrong while saving your vehicle. Please try again, or contact support@urbont.com if it keeps failing.',
      errorCode: 'VEHICLE_SAVE_FAILED',
      action: 'retry',
    });
  }
});

/* ──────────────────────────────────────────────
   POST /api/chauffeur/set-city
────────────────────────────────────────────── */
chauffeurDocsRouter.post('/set-city', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid  = req.supabaseUid;
  const role = req.supabaseRole;

  if (!uid)             return res.status(401).json({ error: 'Unauthorized.',                errorCode: 'UNAUTHORIZED'  });
  if (role !== 'chauffeur' && role !== 'driver') return res.status(403).json({ error: 'Chauffeur account required.', errorCode: 'ACCESS_DENIED' });

  const { city } = req.body as { city?: string };
  if (!city || typeof city !== 'string' || city.trim().length < 2 || city.trim().length > 100)
    return res.status(400).json({ error: 'Valid city name is required (2–100 characters).', errorCode: 'INVALID_CITY' });

  try {
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ operating_city: city.trim(), updated_at: new Date().toISOString() })
      .eq('id', uid);

    if (error) {
      logger.error(`[SetCity] DB error: ${error.message}`);
      return res.status(500).json({
        error: 'We could not save your operating city. Please try again in a moment.',
        errorCode: 'CITY_SAVE_FAILED',
        action: 'retry',
      });
    }

    return res.json({ success: true, city: city.trim() });
  } catch (err) {
    logger.error(`[SetCity] Error: ${errMsg(err)}`);
    return res.status(500).json({
      error: 'Something went wrong while saving your city. Please try again.',
      errorCode: 'CITY_SAVE_FAILED',
      action: 'retry',
    });
  }
});

/* ──────────────────────────────────────────────
   POST /api/chauffeur/documents
   Body: { documents: Record<string, string> }  (base64 data-URLs keyed by doc type)
   Batch upload: uploads every document in parallel and records each one.
   Uber-style: stable paths, upsert-on-conflict, explicit per-doc error reporting.
────────────────────────────────────────────── */
chauffeurDocsRouter.post('/documents', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid  = req.supabaseUid;
  const role = req.supabaseRole;

  if (!uid)             return res.status(401).json({ error: 'Unauthorized.',                errorCode: 'UNAUTHORIZED'  });
  if (role !== 'chauffeur' && role !== 'driver') return res.status(403).json({ error: 'Chauffeur account required.', errorCode: 'ACCESS_DENIED' });

  // El valor puede ser el data URL de siempre, o `{ dataUrl, expiryDate }`.
  type EntradaDoc = string | { dataUrl?: string; expiryDate?: string };
  const { documents } = req.body as { documents?: Record<string, EntradaDoc> };
  if (!documents || typeof documents !== 'object')
    return res.status(400).json({
      error: 'No documents reached us. Please select your files again.',
      errorCode: 'MISSING_FIELDS',
      field: 'documents',
    });

  // Fetch driver name once
  const { data: profileData } = await supabaseAdmin
    .from('profiles').select('first_name, last_name').eq('id', uid).maybeSingle();
  const driverName = profileData
    ? `${profileData.first_name || ''} ${profileData.last_name || ''}`.trim()
    : '';

  const results: Record<string, { success: boolean; storageUrl?: string; error?: string }> = {};

  // Run all uploads in parallel — Uber-style fast batch
  await Promise.all(
    Object.entries(documents).map(async ([docKey, entrada]) => {
      // Esta ruta no comprobaba el tipo de documento, a diferencia de
      // /upload-doc. Por aquí entró un juego de once documentos con nombres que
      // no existen en la lista requerida, y ese conductor quedó imposible de
      // evaluar: tenía todo cargado y aun así le faltaba todo.
      if (!ACCEPTED_DOC_KEYS.includes(docKey)) {
        results[docKey] = { success: false, error: 'Unknown document type' };
        return;
      }

      // Dos formas admitidas: la de siempre, un data URL suelto, y la nueva, un
      // objeto con la fecha de vencimiento al lado. Así el registro puede mandar
      // vencimientos sin que los APK que envían strings dejen de funcionar.
      const esObjeto = !!entrada && typeof entrada === 'object';
      const dataUrl  = esObjeto ? (entrada as { dataUrl?: string }).dataUrl : (entrada as unknown as string);
      const vencimiento = esObjeto
        ? fechaVencimientoValida((entrada as { expiryDate?: string }).expiryDate)
        : null;

      if (!dataUrl || typeof dataUrl !== 'string') {
        results[docKey] = { success: false, error: 'No data provided' };
        return;
      }

      if (vencimiento && yaVencio(vencimiento)) {
        results[docKey] = { success: false, error: `Document expired on ${vencimiento}` };
        return;
      }

      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
      if (!match) {
        results[docKey] = { success: false, error: 'Invalid data URL format' };
        return;
      }

      const [, mimeType, base64] = match;

      if (!ALLOWED_MIME_TYPES.includes(mimeType.toLowerCase())) {
        results[docKey] = { success: false, error: 'Invalid file type (PDF or image required)' };
        return;
      }

      try {
        const buffer = Buffer.from(base64, 'base64');

        if (buffer.length > MAX_FILE_SIZE_BYTES) {
          results[docKey] = { success: false, error: 'File exceeds 10 MB limit' };
          return;
        }

        const ext      = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'bin';
        const safeKey  = docKey.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 60);

        // Stable path — overwrites previous version (Uber-style: one slot per doc type)
        const storagePath = `${uid}/${safeKey}.${ext}`;

        const { error: uploadError } = await supabaseAdmin.storage
          .from('chauffeur-docs')
          .upload(storagePath, buffer, { contentType: mimeType, upsert: true });

        if (uploadError) {
          results[docKey] = { success: false, error: `Storage error: ${uploadError.message}` };
          return;
        }

        const { data: urlData } = supabaseAdmin.storage.from('chauffeur-docs').getPublicUrl(storagePath);
        const storageUrl = urlData?.publicUrl || storagePath;

        const { error: dbErr } = await upsertDocRecord({
          driver_id:     uid,
          doc_key:       safeKey,
          document_type: safeKey,
          storage_url:   storageUrl,
          image_url:     storageUrl,
          file_name:     `${safeKey}.${ext}`,
          driver_name:   driverName,
          status:        'pending',
          updated_at:    new Date().toISOString(),
          expiry_date:   vencimiento,
        });

        if (dbErr) {
          results[docKey] = { success: false, error: `DB error: ${dbErr}` };
          return;
        }

        results[docKey] = { success: true, storageUrl };
      } catch (err) {
        results[docKey] = { success: false, error: errMsg(err) };
      }
    }),
  );

  const successCount = Object.values(results).filter(r => r.success).length;
  const failedDocs   = Object.entries(results).filter(([, r]) => !r.success).map(([k]) => k);

  // Esta ruta marcaba `pending_review` con que se hubiera guardado UN solo
  // documento, así que un conductor a medio cargar aparecía como listo para
  // revisión. Ahora el estado sale del recálculo, igual que en el resto.
  const verificacion = successCount > 0 ? await recalcularVerificacion(uid) : null;

  logger.info(`[BatchUpload] driver=${uid} uploaded=${successCount}/${Object.keys(documents).length}${failedDocs.length ? ` failed=${failedDocs.join(',')}` : ''}`);

  return res.json({
    success:  failedDocs.length === 0,
    uploaded: successCount,
    total:    Object.keys(documents).length,
    results,
    ...(verificacion ? { verificationStatus: verificacion.status, missingDocs: verificacion.missingDocs } : {}),
    ...(failedDocs.length > 0 ? { failedDocs } : {}),
  });
});

/* ──────────────────────────────────────────────
   POST /api/chauffeur/submit
   Final submission — marks profile as pending_review.
────────────────────────────────────────────── */
chauffeurDocsRouter.post('/submit', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.', errorCode: 'UNAUTHORIZED' });

  // Esta ruta ponía `pending_review` sin comprobar absolutamente nada: bastaba
  // llamarla. Ahora el estado lo decide el recálculo sobre los documentos.
  return responderEstadoAlta(uid, res, { exigirCompletos: false, etiqueta: 'Submit' });
});
