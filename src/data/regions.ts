export const birdRegions = [
  'Africa',
  'Asia',
  'Europe',
  'North America',
  'South America',
  'Oceania',
  'Antarctica',
  'Unknown',
] as const;

export type BirdRegion = typeof birdRegions[number];
