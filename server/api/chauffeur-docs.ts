import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../db/client';
import { pool } from '../db/pool';
import { requireSupabaseAuth } from '../middleware';
import { logger } from '../lib/logger';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export const chauffeurDocsRouter = Router();

const REQUIRED_DOC_KEYS = [
  'limoPermit', 'airportPermit', 'inspection', 'portPermit',
  'insurance', 'registration', 'corpFiles', 'w9', 'taxId',
  'license', 'photo',
] as const;

type DocKey = typeof REQUIRED_DOC_KEYS[number];

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
}

async function upsertDocRecord(record: DocRecord): Promise<{ error: string | null }> {
  // Attempt 1 — supabaseAdmin PostgREST (works when unique index exists)
  const { error: e1 } = await supabaseAdmin
    .from('driver_documents')
    .upsert(record, { onConflict: 'driver_id,doc_key', ignoreDuplicates: false });

  if (!e1) return { error: null };

  logger.warn(`[DocUpsert] supabaseAdmin failed (${e1.message}) — attempting schema repair`);

  // Attempt 2 — auto-repair schema (adds missing columns + unique index) then retry
  await ensureDriverDocumentsSchema();

  const { error: e2 } = await supabaseAdmin
    .from('driver_documents')
    .upsert(record, { onConflict: 'driver_id,doc_key', ignoreDuplicates: false });

  if (!e2) return { error: null };

  logger.warn(`[DocUpsert] PostgREST retry failed (${e2.message}) — falling back to pool SQL`);

  // Attempt 3 — direct SQL via pool (bypasses PostgREST entirely)
  try {
    await pool.query(
      `INSERT INTO driver_documents
         (driver_id, doc_key, document_type, storage_url, image_url, file_name, driver_name, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (driver_id, doc_key)
       DO UPDATE SET
         document_type = EXCLUDED.document_type,
         storage_url   = EXCLUDED.storage_url,
         image_url     = EXCLUDED.image_url,
         file_name     = EXCLUDED.file_name,
         driver_name   = EXCLUDED.driver_name,
         status        = 'pending',
         updated_at    = EXCLUDED.updated_at`,
      [
        record.driver_id, record.doc_key, record.document_type,
        record.storage_url, record.image_url, record.file_name,
        record.driver_name, record.status, record.updated_at,
      ],
    );
    return { error: null };
  } catch (poolErr) {
    return { error: errMsg(poolErr) };
  }
}

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

  const { docKey, fileName, mimeType, base64 } = req.body as {
    docKey?: string; fileName?: string; mimeType?: string; base64?: string;
  };

  if (!docKey || !fileName || !mimeType || !base64)
    return res.status(400).json({ error: 'Missing required fields.', errorCode: 'MISSING_FIELDS' });

  if (!REQUIRED_DOC_KEYS.includes(docKey as DocKey))
    return res.status(400).json({ error: 'Invalid document type.', errorCode: 'INVALID_DOC_KEY' });

  if (!ALLOWED_MIME_TYPES.includes(mimeType.toLowerCase()))
    return res.status(400).json({ error: 'Invalid file type. Only PDF and images are allowed.', errorCode: 'INVALID_MIME_TYPE' });

  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);

  try {
    const rawBase64 = base64.replace(/^data:[^;]+;base64,/, '');
    const buffer    = Buffer.from(rawBase64, 'base64');

    if (buffer.length > MAX_FILE_SIZE_BYTES)
      return res.status(400).json({ error: 'File too large. Maximum size is 10 MB.', errorCode: 'FILE_TOO_LARGE' });

    // Stable storage path: re-uploads overwrite the previous file (Uber-style).
    // Format: <uid>/<docKey>.<ext>  — no timestamp, deterministic per driver+doc.
    const ext         = (safeFileName.split('.').pop() || mimeType.split('/')[1] || 'bin').replace('jpeg', 'jpg');
    const storagePath = `${uid}/${docKey}.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('chauffeur-docs')
      .upload(storagePath, buffer, { contentType: mimeType, upsert: true });

    if (uploadError) {
      logger.error(`[DocUpload] Storage error for ${docKey}: ${uploadError.message}`);
      return res.status(500).json({ error: 'File upload failed. Please try again.', errorCode: 'UPLOAD_FAILED' });
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

    // Auto-advance to pending_review if ALL required docs are now present.
    // This way drivers don't need to manually call /submit-documents — the
    // dashboard updates automatically after the last document is uploaded.
    try {
      const { data: existingDocs } = await supabaseAdmin
        .from('driver_documents')
        .select('doc_key')
        .eq('driver_id', uid);
      const uploadedKeys = (existingDocs || []).map((d: { doc_key: string }) => d.doc_key);
      const allUploaded = REQUIRED_DOC_KEYS.every(k => uploadedKeys.includes(k));
      if (allUploaded) {
        const { error: advanceErr } = await supabaseAdmin
          .from('profiles')
          .update({ verification_status: 'pending_review', updated_at: new Date().toISOString() })
          .eq('id', uid);
        if (!advanceErr) {
          logger.info(`[DocUpload] All ${REQUIRED_DOC_KEYS.length} docs present — auto-advanced to pending_review for ${uid}`);
          return res.json({ success: true, storageUrl, docKey, verificationStatus: 'pending_review' });
        }
        // supabaseAdmin failed (PostgREST schema cache issue or RLS) — retry via direct SQL
        logger.warn(`[DocUpload] supabaseAdmin profile update failed (${advanceErr.message}) — retrying via pool`);
        try {
          await pool.query(
            `UPDATE profiles SET verification_status = 'pending_review', updated_at = NOW() WHERE id = $1`,
            [uid],
          );
          logger.info(`[DocUpload] All ${REQUIRED_DOC_KEYS.length} docs present — auto-advanced via pool to pending_review for ${uid}`);
          return res.json({ success: true, storageUrl, docKey, verificationStatus: 'pending_review' });
        } catch (poolAdvErr) {
          logger.warn(`[DocUpload] Pool profile update also failed: ${errMsg(poolAdvErr)}`);
        }
      }
    } catch (statusErr) {
      logger.warn(`[DocUpload] Could not auto-update verification_status: ${errMsg(statusErr)}`);
    }

    return res.json({ success: true, storageUrl, docKey });
  } catch (err) {
    logger.error(`[DocUpload] Unexpected error: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Upload failed. Please try again.', errorCode: 'SERVER_ERROR' });
  }
});

/* ──────────────────────────────────────────────
   POST /api/chauffeur/submit-documents
   Validates all required docs are present, then marks as pending_review.
────────────────────────────────────────────── */
chauffeurDocsRouter.post('/submit-documents', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid  = req.supabaseUid;
  const role = req.supabaseRole;

  if (!uid)             return res.status(401).json({ error: 'Unauthorized.',                errorCode: 'UNAUTHORIZED'  });
  if (role !== 'chauffeur' && role !== 'driver') return res.status(403).json({ error: 'Chauffeur account required.', errorCode: 'ACCESS_DENIED' });

  try {
    const { data: docs, error: docsErr } = await supabaseAdmin
      .from('driver_documents')
      .select('doc_key')
      .eq('driver_id', uid);

    if (docsErr) {
      logger.error(`[DocSubmit] Could not fetch docs: ${docsErr.message}`);
      return res.status(500).json({ error: 'Could not verify documents. Please try again.', errorCode: 'SERVER_ERROR' });
    }

    const uploadedKeys = (docs || []).map((d: { doc_key: string }) => d.doc_key);
    const missingDocs  = REQUIRED_DOC_KEYS.filter(k => !uploadedKeys.includes(k));

    if (missingDocs.length > 0) {
      return res.status(400).json({
        error: `Missing documents: ${missingDocs.join(', ')}`,
        errorCode: 'INCOMPLETE_DOCUMENTS',
        missingDocs,
      });
    }

    const { error: updateErr } = await supabaseAdmin
      .from('profiles')
      .update({ verification_status: 'pending_review', updated_at: new Date().toISOString() })
      .eq('id', uid);

    if (updateErr) {
      logger.warn(`[DocSubmit] supabaseAdmin profile update failed (${updateErr.message}) — retrying via pool`);
      try {
        await pool.query(
          `UPDATE profiles SET verification_status = 'pending_review', updated_at = NOW() WHERE id = $1`,
          [uid],
        );
      } catch (poolSubmitErr) {
        logger.error(`[DocSubmit] pool profile update also failed: ${errMsg(poolSubmitErr)}`);
        return res.status(500).json({ error: 'Failed to submit documents.', errorCode: 'SERVER_ERROR' });
      }
    }

    return res.json({ success: true, status: 'pending_review', verificationStatus: 'pending_review' });
  } catch (err) {
    logger.error(`[DocSubmit] Error: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Submission failed.', errorCode: 'SERVER_ERROR' });
  }
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
    return res.status(500).json({ error: 'Failed to fetch status.', errorCode: 'SERVER_ERROR' });
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

  if (!make || !model || !year || !color || !plate)
    return res.status(400).json({ error: 'All vehicle fields are required (make, model, year, color, plate).', errorCode: 'MISSING_FIELDS' });

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
      return res.status(500).json({ error: 'Failed to save vehicle info.', errorCode: 'SERVER_ERROR' });
    }

    return res.json({ success: true, vehicle });
  } catch (err) {
    logger.error(`[SetVehicle] Error: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Failed to save vehicle info.', errorCode: 'SERVER_ERROR' });
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
      return res.status(500).json({ error: 'Failed to set city.', errorCode: 'SERVER_ERROR' });
    }

    return res.json({ success: true, city: city.trim() });
  } catch (err) {
    logger.error(`[SetCity] Error: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Failed to set city.', errorCode: 'SERVER_ERROR' });
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

  const { documents } = req.body as { documents?: Record<string, string> };
  if (!documents || typeof documents !== 'object')
    return res.status(400).json({ error: 'documents field is required.', errorCode: 'MISSING_FIELDS' });

  // Fetch driver name once
  const { data: profileData } = await supabaseAdmin
    .from('profiles').select('first_name, last_name').eq('id', uid).maybeSingle();
  const driverName = profileData
    ? `${profileData.first_name || ''} ${profileData.last_name || ''}`.trim()
    : '';

  const results: Record<string, { success: boolean; storageUrl?: string; error?: string }> = {};

  // Run all uploads in parallel — Uber-style fast batch
  await Promise.all(
    Object.entries(documents).map(async ([docKey, dataUrl]) => {
      if (!dataUrl || typeof dataUrl !== 'string') {
        results[docKey] = { success: false, error: 'No data provided' };
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

  // Only mark pending_review when at least some docs were saved
  let batchProfileUpdated = false;
  if (successCount > 0) {
    const { error: batchUpdateErr } = await supabaseAdmin
      .from('profiles')
      .update({ verification_status: 'pending_review', updated_at: new Date().toISOString() })
      .eq('id', uid);
    if (batchUpdateErr) {
      // supabaseAdmin failed — retry via direct SQL (bypasses PostgREST schema cache)
      logger.warn(`[BatchUpload] supabaseAdmin profile update failed (${batchUpdateErr.message}) — retrying via pool`);
      try {
        await pool.query(
          `UPDATE profiles SET verification_status = 'pending_review', updated_at = NOW() WHERE id = $1`,
          [uid],
        );
        batchProfileUpdated = true;
      } catch (poolBatchErr) {
        logger.error(`[BatchUpload] pool profile update also failed: ${errMsg(poolBatchErr)}`);
      }
    } else {
      batchProfileUpdated = true;
    }
  }

  logger.info(`[BatchUpload] driver=${uid} uploaded=${successCount}/${Object.keys(documents).length}${failedDocs.length ? ` failed=${failedDocs.join(',')}` : ''}`);

  return res.json({
    success:  failedDocs.length === 0,
    uploaded: successCount,
    total:    Object.keys(documents).length,
    results,
    // Let the client know it can advance the UI to pending_review state
    ...(batchProfileUpdated ? { verificationStatus: 'pending_review' } : {}),
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

  try {
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ verification_status: 'pending_review', updated_at: new Date().toISOString() })
      .eq('id', uid);

    if (error) {
      logger.error(`[Submit] DB error: ${error.message}`);
      return res.status(500).json({ error: 'Failed to submit application.', errorCode: 'SERVER_ERROR' });
    }

    return res.json({ success: true, verificationStatus: 'pending_review' });
  } catch (err) {
    logger.error(`[Submit] Error: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Failed to submit application.', errorCode: 'SERVER_ERROR' });
  }
});
