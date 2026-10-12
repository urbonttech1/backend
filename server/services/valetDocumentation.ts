/**
 * Expediente del valet: compañía, acuerdo vigente y W-9.
 * Lo usan el login, la activación y la lista del panel.
 */
import { supabaseAdmin } from '../db/client';
import { ACUERDO_VERSION } from './valetAgreement';
import { companiaCompleta, companiaDesdeFila, type CompaniaValet } from './valetCompany';
import { estadoW9, expediente, faltantesActivacion, type EstadoAcuerdo, type EstadoExpediente, type EstadoW9 } from './valetPacket';

const PREFIJO_W9 = 'valet-tax:';

export interface DocumentacionValet {
  companyComplete: boolean;
  /** Lo que el valet escribió; el panel lo muestra para revisarlo. */
  company: CompaniaValet;
  agreement: EstadoAcuerdo;
  agreementVersion: string | null;
  agreementAcceptedAt: string | null;
  w9: EstadoW9;
  accountDocumentation: EstadoExpediente;
}

export function rutaPrivadaW9(storageUrl: string | null | undefined): string | null {
  if (!storageUrl || !storageUrl.startsWith(PREFIJO_W9)) return null;
  return storageUrl.slice(PREFIJO_W9.length);
}

export function marcarRutaW9(path: string): string {
  return `${PREFIJO_W9}${path}`;
}

export async function urlFirmadaW9(storageUrl: string | null | undefined): Promise<string | null> {
  const path = rutaPrivadaW9(storageUrl);
  if (!path) return null;
  const { data } = await supabaseAdmin.storage.from('valet-tax').createSignedUrl(path, 60 * 60);
  return data?.signedUrl ?? null;
}

export async function documentacionDe(userId: string): Promise<DocumentacionValet> {
  const [perfil, firma, w9] = await Promise.all([
    supabaseAdmin.from('profiles')
      .select('company_legal_name, business_name, company_entity_type, company_address, company_phone, company_email, company_rep_name')
      .eq('id', userId).maybeSingle(),
    supabaseAdmin.from('valet_agreement_acceptances')
      .select('agreement_version, accepted_at')
      .eq('user_id', userId)
      .eq('agreement_version', ACUERDO_VERSION)
      .order('accepted_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin.from('driver_documents')
      .select('status, storage_url')
      .eq('driver_id', userId)
      .eq('doc_key', 'w9')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const datosCompania = companiaDesdeFila(perfil.data as Record<string, unknown> | null);
  const company = companiaCompleta(datosCompania);
  const agreement: EstadoAcuerdo = firma.data ? 'accepted' : 'pending';
  const w9Estado = estadoW9((w9.data?.status as string | undefined) ?? null);
  return {
    companyComplete: company,
    company: datosCompania,
    agreement,
    agreementVersion: (firma.data?.agreement_version as string | undefined) ?? null,
    agreementAcceptedAt: (firma.data?.accepted_at as string | undefined) ?? null,
    w9: w9Estado,
    accountDocumentation: expediente({ company, agreement, w9: w9Estado }),
  };
}

export async function faltantesParaActivar(userId: string): Promise<string[]> {
  const d = await documentacionDe(userId);
  return faltantesActivacion({ company: d.companyComplete, agreement: d.agreement, w9: d.w9 });
}
