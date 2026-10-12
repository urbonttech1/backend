/**
 * Datos de la compañía que el valet representa.
 * Sin ellos la cuenta se queda en Pending Documentation.
 */

export const TIPOS_EMPRESA = [
  'llc',
  'corporation',
  'sole_proprietorship',
  'partnership',
  'other',
] as const;

export type TipoEmpresa = (typeof TIPOS_EMPRESA)[number];

export interface CompaniaValet {
  legalName?: string | null;
  tradeName?: string | null;
  entityType?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  authorizedRep?: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function limpio(v: string | null | undefined): string {
  return (v ?? '').trim();
}

/** Lo que falta para dar por completa la ficha. El representante es opcional. */
export function faltantesCompania(c: CompaniaValet): string[] {
  const falta: string[] = [];
  if (!limpio(c.legalName)) falta.push('legalName');
  if (!limpio(c.tradeName)) falta.push('tradeName');
  if (!TIPOS_EMPRESA.includes(limpio(c.entityType) as TipoEmpresa)) falta.push('entityType');
  if (!limpio(c.address)) falta.push('address');
  if (!limpio(c.phone)) falta.push('phone');
  if (!EMAIL.test(limpio(c.email))) falta.push('email');
  return falta;
}

export function companiaCompleta(c: CompaniaValet): boolean {
  return faltantesCompania(c).length === 0;
}

/** Columnas de `profiles` a partir del formulario. */
export function columnasCompania(c: CompaniaValet): Record<string, string | null> {
  return {
    company_legal_name: limpio(c.legalName) || null,
    business_name: limpio(c.tradeName) || null,
    company_entity_type: limpio(c.entityType) || null,
    company_address: limpio(c.address) || null,
    company_phone: limpio(c.phone) || null,
    company_email: limpio(c.email) || null,
    company_rep_name: limpio(c.authorizedRep) || null,
  };
}

export function companiaDesdeFila(row: Record<string, unknown> | null | undefined): CompaniaValet {
  const r = row ?? {};
  return {
    legalName: (r.company_legal_name as string | null) ?? null,
    tradeName: (r.business_name as string | null) ?? null,
    entityType: (r.company_entity_type as string | null) ?? null,
    address: (r.company_address as string | null) ?? null,
    phone: (r.company_phone as string | null) ?? null,
    email: (r.company_email as string | null) ?? null,
    authorizedRep: (r.company_rep_name as string | null) ?? null,
  };
}
