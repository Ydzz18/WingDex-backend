export const philippineRegions = [
  { code: 'NCR', name: 'National Capital Region', psgc: '130000000', ebirdSubregions: ['National Capital Region (Manila)'] },
  { code: 'CAR', name: 'Cordillera Administrative Region', psgc: '140000000', ebirdSubregions: ['Abra', 'Apayao', 'Benguet', 'Ifugao', 'Kalinga', 'Mountain Province'] },
  { code: 'REGION_I', name: 'Ilocos Region', psgc: '010000000', ebirdSubregions: ['Ilocos Norte', 'Ilocos Sur', 'La Union', 'Pangasinan'] },
  { code: 'REGION_II', name: 'Cagayan Valley', psgc: '020000000', ebirdSubregions: ['Batanes', 'Cagayan', 'Isabela', 'Nueva Vizcaya', 'Quirino'] },
  { code: 'REGION_III', name: 'Central Luzon', psgc: '030000000', ebirdSubregions: ['Aurora', 'Bataan', 'Bulacan', 'Nueva Ecija', 'Pampanga', 'Tarlac', 'Zambales'] },
  { code: 'REGION_IV_A', name: 'CALABARZON', psgc: '040000000', ebirdSubregions: ['Batangas', 'Cavite', 'Laguna', 'Quezon', 'Rizal'] },
  { code: 'REGION_IV_B', name: 'MIMAROPA', psgc: '170000000', ebirdSubregions: ['Marinduque', 'Occidental Mindoro', 'Oriental Mindoro', 'Palawan', 'Romblon'] },
  { code: 'REGION_V', name: 'Bicol Region', psgc: '050000000', ebirdSubregions: ['Albay', 'Camarines Norte', 'Camarines Sur', 'Catanduanes', 'Masbate', 'Sorsogon'] },
  { code: 'REGION_VI', name: 'Western Visayas', psgc: '060000000', ebirdSubregions: ['Aklan', 'Antique', 'Capiz', 'Guimaras', 'Iloilo'] },
  { code: 'REGION_VII', name: 'Central Visayas', psgc: '070000000', ebirdSubregions: ['Bohol', 'Cebu'] },
  { code: 'REGION_VIII', name: 'Eastern Visayas', psgc: '080000000', ebirdSubregions: ['Biliran', 'Eastern Samar', 'Leyte', 'Northern Samar', 'Samar', 'Southern Leyte'] },
  { code: 'REGION_IX', name: 'Zamboanga Peninsula', psgc: '090000000', ebirdSubregions: ['Zamboanga del Norte', 'Zamboanga del Sur', 'Zamboanga Sibugay'], unmappedAdministrativeUnits: ['City of Isabela'] },
  { code: 'REGION_X', name: 'Northern Mindanao', psgc: '100000000', ebirdSubregions: ['Bukidnon', 'Camiguin', 'Lanao del Norte', 'Misamis Occidental', 'Misamis Oriental'] },
  { code: 'REGION_XI', name: 'Davao Region', psgc: '110000000', ebirdSubregions: ['Davao de Oro', 'Davao Occidental', 'Davao Oriental', 'Davao del Norte', 'Davao del Sur'] },
  { code: 'REGION_XII', name: 'SOCCSKSARGEN', psgc: '120000000', ebirdSubregions: ['Cotabato', 'Sarangani', 'South Cotabato', 'Sultan Kudarat'] },
  { code: 'REGION_XIII', name: 'Caraga', psgc: '160000000', ebirdSubregions: ['Agusan del Norte', 'Agusan del Sur', 'Dinagat Islands', 'Surigao del Norte', 'Surigao del Sur'] },
  { code: 'BARMM', name: 'Bangsamoro Autonomous Region in Muslim Mindanao', psgc: '150000000', ebirdSubregions: ['Basilan', 'Lanao del Sur', 'Maguindanao', 'Sulu', 'Tawi-Tawi'], unmappedAdministrativeUnits: ['Cotabato City'] },
  { code: 'NIR', name: 'Negros Island Region', psgc: '180000000', ebirdSubregions: ['Negros Occidental', 'Negros Oriental', 'Siquijor'] },
] as const;

export type PhilippineRegionCode = (typeof philippineRegions)[number]['code'];
export type PhilippineRegion = (typeof philippineRegions)[number];

export const philippineRegionCount = philippineRegions.length;

export function findPhilippineRegion(code: string | null | undefined): PhilippineRegion | undefined {
  if (!code) return undefined;
  const normalized = code.trim().toUpperCase().replace(/^PH[-_]/, '');
  return philippineRegions.find((region) => region.code === normalized || region.name.toUpperCase() === normalized) ?? undefined;
}
