import { findPhilippineRegion, type PhilippineRegion } from './philippineRegions.js';
import { philippineRegionalBoundaryEncodings } from './data/philippineRegionalBoundaries.js';
import { minimumObservationConfidence } from './observationRules.js';

export type RegionalObservation = {
  id?: string;
  confidence: number;
  ebirdSpecies?: {
    speciesCode?: string;
    comName?: string;
    sciName?: string;
    category?: string;
  } | null;
  location?: Point | null;
};

export const universalRegionalRankDefinitions = [
  { id: 'hatchling', title: 'HATCHLING', description: 'The beginning of every discovery.', label: '1 / 10% / 25% / 50% / 75% / 100%', thresholdPercent: 1 },
  { id: 'feather-scout', title: 'FEATHER SCOUT', description: 'The journey beyond the nest.', label: '1 / 10% / 25% / 50% / 75% / 100%', thresholdPercent: 10 },
  { id: 'canopy-tracker', title: 'CANOPY TRACKER', description: 'A growing knowledge of the wild.', label: '1 / 10% / 25% / 50% / 75% / 100%', thresholdPercent: 25 },
  { id: 'sky-ranger', title: 'SKY RANGER', description: 'A master of the skies begins to emerge.', label: '1 / 10% / 25% / 50% / 75% / 100%', thresholdPercent: 50 },
  { id: 'avian-guardian', title: 'AVIAN GUARDIAN', description: 'A protector and dedicated student of birds.', label: '1 / 10% / 25% / 50% / 75% / 100%', thresholdPercent: 75 },
  { id: 'wing-master', title: 'WING MASTER', description: 'The ultimate regional bird expert.', label: '1 / 10% / 25% / 50% / 75% / 100%', thresholdPercent: 100 },
] as const;

export type RegionalRankSnapshot = {
  version: string;
  regionCode: string;
  regionName: string;
  eligibleSpeciesCount: number;
  snapshotDate: string;
  source: 'ebird-product-spplist';
  valueHash: string;
};

export type RegionalProgress = {
  currentRank: (typeof universalRegionalRankDefinitions)[number] | null;
  nextRank: (typeof universalRegionalRankDefinitions)[number] | null;
  previousThreshold: number;
  nextThreshold: number;
  totalQualifyingSpecies: number;
  totalEligibleSpecies: number;
  percentageComplete: number;
  requiredMore: number;
  progressRatio: number;
  thresholds: number[];
  status: 'ready' | 'blocked';
  message?: string;
};

export function computeRegionalThresholds(eligibleSpeciesCount: number) {
  if (!Number.isFinite(eligibleSpeciesCount) || eligibleSpeciesCount <= 0) {
    return [0, 0, 0, 0, 0, 0];
  }
  const total = Math.floor(eligibleSpeciesCount);
  return [1, 10, 25, 50, 75, 100].map((percentage, index) =>
    index === 0 ? 1 : Math.ceil((total * percentage) / 100),
  );
}

export function calculateRegionalProgress(
  totalEligibleSpecies: number,
  totalQualifyingSpecies: number,
  totalBoundariesReady = true,
  boundaryMessage?: string,
): RegionalProgress {
  const thresholds = computeRegionalThresholds(totalEligibleSpecies);
  if (totalEligibleSpecies <= 0) {
    return {
      currentRank: null,
      nextRank: universalRegionalRankDefinitions[0],
      previousThreshold: 0,
      nextThreshold: 1,
      totalQualifyingSpecies,
      totalEligibleSpecies: 0,
      percentageComplete: 0,
      requiredMore: 1,
      progressRatio: 0,
      thresholds,
      status: totalBoundariesReady ? 'ready' : 'blocked',
      message: totalBoundariesReady ? undefined : boundaryMessage ?? 'Choose a home region and load its checklist before progress can be calculated.',
    };
  }
  const rankDefinitions = universalRegionalRankDefinitions.map((rank, index) => ({
    ...rank,
    threshold: thresholds[index] ?? totalEligibleSpecies,
  }));

  const currentRank = [...rankDefinitions].reverse().find((rank) => totalQualifyingSpecies >= rank.threshold) ?? null;
  const nextRank = rankDefinitions.find((rank) => totalQualifyingSpecies < rank.threshold) ?? null;

  const previousThreshold = currentRank ? currentRank.threshold : 0;
  const nextThreshold = nextRank ? nextRank.threshold : totalEligibleSpecies || 0;
  const progressRatio = nextRank && nextThreshold > previousThreshold
    ? Math.max(0, Math.min(1, (totalQualifyingSpecies - previousThreshold) / (nextThreshold - previousThreshold)))
    : 1;
  const percentageComplete = totalEligibleSpecies > 0
    ? Math.min(100, (totalQualifyingSpecies / totalEligibleSpecies) * 100)
    : 0;
  const requiredMore = nextRank ? Math.max(0, nextRank.threshold - totalQualifyingSpecies) : 0;

  return {
    currentRank,
    nextRank,
    previousThreshold,
    nextThreshold,
    totalQualifyingSpecies,
    totalEligibleSpecies,
    percentageComplete,
    requiredMore,
    progressRatio,
    thresholds,
    status: totalBoundariesReady ? 'ready' : 'blocked',
    message: totalBoundariesReady ? undefined : boundaryMessage ?? 'Official regional boundary data is required before GPS-tagged observations can count.',
  };
}

export function regionStatusMessage(region: PhilippineRegion | undefined) {
  if (!region) return 'Choose a home region to see your progress.';
  return `Home region: ${region.name}. Only GPS-tagged observations inside this region count.`;
}

export function normalizeRegionCode(input: string | null | undefined): string | undefined {
  const code = input?.trim();
  if (!code) return undefined;
  const region = findPhilippineRegion(code);
  return region?.code ?? code.toUpperCase();
}

type Point = { latitude: number; longitude: number };
type Ring = readonly (readonly [number, number])[];
type PolygonCoordinates = readonly Ring[];
const decodedBoundaryCache = new Map<string, PolygonCoordinates[]>();

function decodePolyline(encoded: string): Ring {
  const coordinates: [number, number][] = [];
  let latitude = 0;
  let longitude = 0;
  let cursor = 0;
  const nextDelta = () => {
    let result = 0;
    let shift = 0;
    let chunk: number;
    do {
      chunk = encoded.charCodeAt(cursor++) - 63;
      result |= (chunk & 0x1f) << shift;
      shift += 5;
    } while (chunk >= 0x20 && cursor < encoded.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (cursor < encoded.length) {
    latitude += nextDelta();
    longitude += nextDelta();
    coordinates.push([longitude / 1_000_000, latitude / 1_000_000]);
  }
  return coordinates;
}

function getRegionPolygons(regionCode: string): PolygonCoordinates[] {
  const cached = decodedBoundaryCache.get(regionCode);
  if (cached) return cached;
  const encoded = philippineRegionalBoundaryEncodings[regionCode]?.encoded;
  if (!encoded) return [];
  const polygons = encoded.split('\r').map((polygon) =>
    polygon.split('\n').map((ring) => decodePolyline(ring)),
  );
  decodedBoundaryCache.set(regionCode, polygons);
  return polygons;
}

function pointInRing(longitude: number, latitude: number, ring: Ring): -1 | 0 | 1 {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x1, y1] = ring[previous];
    const [x2, y2] = ring[index];
    const cross = (longitude - x1) * (y2 - y1) - (latitude - y1) * (x2 - x1);
    if (Math.abs(cross) <= 1e-10
      && longitude >= Math.min(x1, x2) - 1e-10
      && longitude <= Math.max(x1, x2) + 1e-10
      && latitude >= Math.min(y1, y2) - 1e-10
      && latitude <= Math.max(y1, y2) + 1e-10) {
      return -1;
    }
    if ((y1 > latitude) !== (y2 > latitude)
      && longitude < ((x2 - x1) * (latitude - y1)) / (y2 - y1) + x1) {
      inside = !inside;
    }
  }
  return inside ? 1 : 0;
}

function pointInPolygon(longitude: number, latitude: number, rings: PolygonCoordinates) {
  const outer = pointInRing(longitude, latitude, rings[0] ?? []);
  if (outer === 0) return false;
  if (outer === -1) return true;
  return !rings.slice(1).some((ring) => pointInRing(longitude, latitude, ring) === 1);
}

export function pointInPhilippineRegion(point: Point, region: PhilippineRegion): boolean {
  if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) return false;
  const polygons = getRegionPolygons(region.code);
  return polygons.some((polygon) => pointInPolygon(point.longitude, point.latitude, polygon));
}

export function collectQualifyingSpeciesForRegion({
  observations,
  region,
  speciesCodes,
}: {
  observations: RegionalObservation[];
  region: PhilippineRegion | undefined;
  speciesCodes: readonly string[];
}) {
  if (!region) {
    return { speciesCodes: [], count: 0, status: 'blocked' as const, message: 'Please choose a Philippine home region.' };
  }
  const eligibleCodes = new Set(speciesCodes.map((code) => code.trim().toLowerCase()).filter(Boolean));
  if (eligibleCodes.size === 0) {
    return {
      speciesCodes: [],
      count: 0,
      status: 'ready' as const,
    };
  }

  const uniqueCodes = new Map<string, string>();
  for (const observation of observations) {
    const speciesCode = observation.ebirdSpecies?.speciesCode?.trim();
    const location = observation.location;
    if (!speciesCode
      || !Number.isFinite(observation.confidence)
      || observation.confidence < minimumObservationConfidence
      || observation.ebirdSpecies?.category !== 'species'
      || !eligibleCodes.has(speciesCode.toLowerCase())
      || !location
      || !pointInPhilippineRegion(location, region)) continue;
    if (!uniqueCodes.has(speciesCode.toLowerCase())) uniqueCodes.set(speciesCode.toLowerCase(), speciesCode);
  }

  return {
    speciesCodes: Array.from(uniqueCodes.values()),
    count: uniqueCodes.size,
    status: 'ready' as const,
  };
}
