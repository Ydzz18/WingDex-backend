import { createHash } from 'node:crypto';
import { findPhilippineRegion, philippineRegions } from './philippineRegions.js';

const apiBaseUrl = 'https://api.ebird.org/v2';
const speciesCodePattern = /^[a-z0-9]{2,12}$/i;
const eBirdNameAliases: Record<string, string[]> = {
  'Davao de Oro': ['Compostela Valley'],
};

export type RegionalChecklistSnapshot = {
  regionCode: string;
  regionName: string;
  eligibleSpeciesCount: number;
  speciesCodes: string[];
  sourceRegionCodes: string[];
  valueHash: string;
  version: string;
  asOf: string;
  snapshotDate: string;
  source: 'ebird-product-spplist';
};

export class RegionalChecklistSourceError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

export function checklistHash(speciesCodes: readonly string[]) {
  return createHash('sha256')
    .update([...new Set(speciesCodes.map((code) => code.trim().toLowerCase()))].sort().join('\n'))
    .digest('hex');
}

export function validateStoredChecklistSnapshot(row: Record<string, unknown>): RegionalChecklistSnapshot | null {
  const speciesCodes = row.species_codes;
  if (!Array.isArray(speciesCodes)
    || speciesCodes.some((code) => typeof code !== 'string' || !speciesCodePattern.test(code))
    || typeof row.eligible_species_count !== 'number'
    || row.eligible_species_count !== speciesCodes.length
    || typeof row.checklist_hash !== 'string'
    || typeof row.checklist_version !== 'string'
    || typeof row.region_code !== 'string'
    || typeof row.region_name !== 'string'
    || typeof row.snapshot_as_of !== 'string'
    || !Array.isArray(row.source_region_codes)
    || row.source_region_codes.some((code) => typeof code !== 'string')) {
    return null;
  }
  const sortedCodes = [...speciesCodes] as string[];
  if (sortedCodes.some((code, index) => index > 0 && sortedCodes[index - 1] > code)) return null;
  const hash = checklistHash(sortedCodes);
  if (hash !== row.checklist_hash || row.checklist_version !== `ebird-spplist:${hash}`) return null;
  return {
    regionCode: row.region_code,
    regionName: row.region_name,
    eligibleSpeciesCount: row.eligible_species_count,
    speciesCodes: sortedCodes,
    sourceRegionCodes: row.source_region_codes as string[],
    valueHash: hash,
    version: row.checklist_version,
    asOf: row.snapshot_as_of,
    snapshotDate: row.checklist_snapshot_date instanceof Date
      ? row.checklist_snapshot_date.toISOString().slice(0, 10)
      : typeof row.checklist_snapshot_date === 'string'
        ? row.checklist_snapshot_date.slice(0, 10)
        : row.snapshot_as_of.slice(0, 10),
    source: 'ebird-product-spplist',
  };
}

export function createRegionalChecklistProvider(options: {
  apiKey?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
} = {}) {
  const apiKey = options.apiKey?.trim();
  const request = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let cachedRegions: { expiresAt: number; rows: { code: string; name: string }[] } | null = null;

  async function getJson<T>(path: string): Promise<T> {
    if (!apiKey) {
      throw new RegionalChecklistSourceError('eBird refresh is unavailable. Configure EBIRD_API_KEY on the backend.', 503);
    }
    let response: Response;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await request(`${apiBaseUrl}${path}`, {
          headers: { 'X-eBirdApiToken': apiKey },
          signal: AbortSignal.timeout(12_000),
        });
      } catch {
        throw new RegionalChecklistSourceError('Could not reach eBird while refreshing this regional checklist.');
      }
      if (response.status !== 429 || attempt >= 3) break;
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter, 60) * 1000
        : 3000 * (attempt + 1));
    }
    if (response.status === 429) {
      throw new RegionalChecklistSourceError('eBird request limit reached. Retry the regional refresh later.', 429);
    }
    if (!response.ok) {
      throw new RegionalChecklistSourceError(`eBird could not verify the regional checklist source (${response.status}).`);
    }
    try {
      return await response.json() as T;
    } catch {
      throw new RegionalChecklistSourceError('eBird returned an unreadable regional checklist response.');
    }
  }

  async function getRegionReferences() {
    if (cachedRegions && cachedRegions.expiresAt > Date.now()) return cachedRegions.rows;
    const body = await getJson<unknown>('/ref/region/list/subnational1/PH');
    if (!Array.isArray(body) || body.some((row) =>
      typeof row !== 'object'
      || row === null
      || !('code' in row) || typeof row.code !== 'string'
      || !('name' in row) || typeof row.name !== 'string')) {
      throw new RegionalChecklistSourceError('eBird returned an invalid Philippine region reference list.');
    }
    const rows = body as { code: string; name: string }[];
    cachedRegions = { expiresAt: Date.now() + 60 * 60 * 1000, rows };
    return rows;
  }

  return {
    async refresh(regionCode: string): Promise<RegionalChecklistSnapshot> {
      const region = findPhilippineRegion(regionCode);
      if (!region) throw new RegionalChecklistSourceError('Choose a valid Philippine PSGC region code.', 400);
      const missingUnits = 'unmappedAdministrativeUnits' in region
        ? region.unmappedAdministrativeUnits
        : [];
      if (missingUnits.length > 0) {
        throw new RegionalChecklistSourceError(
          `eBird has no verified subnational region mapping for ${missingUnits.join(', ')}. This region checklist cannot be published yet.`,
          409,
        );
      }

      const references = await getRegionReferences();
      const referenceByName = new Map(references.map((entry) => [entry.name.trim().toLocaleLowerCase(), entry.code]));
      const sourceRegionCodes: string[] = [];
      const missing = (region.ebirdSubregions as readonly string[]).filter((name) => {
        const code = [name, ...(eBirdNameAliases[name] ?? [])]
          .map((candidate) => referenceByName.get(candidate.trim().toLocaleLowerCase()))
          .find((candidate): candidate is string => Boolean(candidate));
        if (code) sourceRegionCodes.push(code);
        return !code;
      });
      if (missing.length > 0 || sourceRegionCodes.length !== region.ebirdSubregions.length) {
        throw new RegionalChecklistSourceError(
          `eBird's current Philippine region reference list does not verify: ${missing.join(', ') || 'all constituent region codes'}.`,
          409,
        );
      }

      const species = new Set<string>();
      for (const code of sourceRegionCodes) {
        const body = await getJson<unknown>(`/product/spplist/${encodeURIComponent(code)}`);
        if (!Array.isArray(body) || body.some((value) => typeof value !== 'string' || !speciesCodePattern.test(value))) {
          throw new RegionalChecklistSourceError(`eBird returned an invalid species-code list for ${code}.`);
        }
        for (const value of body as string[]) species.add(value.toLowerCase());
      }
      const speciesCodes = [...species].sort();
      const valueHash = checklistHash(speciesCodes);
      const asOf = now().toISOString();
      return {
        regionCode: region.code,
        regionName: region.name,
        eligibleSpeciesCount: speciesCodes.length,
        speciesCodes,
        sourceRegionCodes: sourceRegionCodes.sort(),
        valueHash,
        version: `ebird-spplist:${valueHash}`,
        asOf,
        snapshotDate: asOf.slice(0, 10),
        source: 'ebird-product-spplist',
      };
    },
  };
}

export const regionalRankDefinitions = [
  { rank_code: 'hatchling', title: 'HATCHLING', description: 'The beginning of every discovery.', rank_order: 1, threshold_type: 'first_species', threshold_value: 1 },
  { rank_code: 'feather-scout', title: 'FEATHER SCOUT', description: 'The journey beyond the nest.', rank_order: 2, threshold_type: 'percentage', threshold_value: 10 },
  { rank_code: 'canopy-tracker', title: 'CANOPY TRACKER', description: 'A growing knowledge of the wild.', rank_order: 3, threshold_type: 'percentage', threshold_value: 25 },
  { rank_code: 'sky-ranger', title: 'SKY RANGER', description: 'A master of the skies begins to emerge.', rank_order: 4, threshold_type: 'percentage', threshold_value: 50 },
  { rank_code: 'avian-guardian', title: 'AVIAN GUARDIAN', description: 'A protector and dedicated student of birds.', rank_order: 5, threshold_type: 'percentage', threshold_value: 75 },
  { rank_code: 'wing-master', title: 'WING MASTER', description: 'The ultimate regional bird expert.', rank_order: 6, threshold_type: 'percentage', threshold_value: 100 },
] as const;

export { philippineRegions };
