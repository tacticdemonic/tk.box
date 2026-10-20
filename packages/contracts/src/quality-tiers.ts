// Quality ladder without zod: the browser bundle imports this file, and some Fire TV WebViews
// (Chromium 66) cannot parse the schema library the contracts module pulls in.
export const qualityTiers = [
  { id: '1080p-20', label: '1080p HD (High)', height: 1080, bitrateKbps: 20000 },
  { id: '1080p-12', label: '1080p HD (Medium)', height: 1080, bitrateKbps: 12000 },
  { id: '1080p-10', label: '1080p HD', height: 1080, bitrateKbps: 10000 },
  { id: '1080p-8', label: '1080p HD', height: 1080, bitrateKbps: 8000 },
  { id: '720p-4', label: '720p HD (High)', height: 720, bitrateKbps: 4000 },
  { id: '720p-3', label: '720p HD (Medium)', height: 720, bitrateKbps: 3000 },
  { id: '720p-2', label: '720p HD', height: 720, bitrateKbps: 2000 },
  { id: '480p-1.5', label: '480p', height: 480, bitrateKbps: 1500 }
] as const;
export type QualityTier = typeof qualityTiers[number];
