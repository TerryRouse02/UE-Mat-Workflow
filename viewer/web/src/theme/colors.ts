const PIN: Record<string, string> = {
  float: '#7ec96f', float1: '#7ec96f', scalar: '#7ec96f',
  float2: '#5cc4c4', vec2: '#5cc4c4',
  float3: '#e0b34d', vec3: '#e0b34d',
  float4: '#b48cf0', vec4: '#b48cf0',
  texture: '#5b9bf0', bool: '#e0728a',
  materialattributes: '#e8ebef', attrs: '#e8ebef',
};
const PIN_DEFAULT = '#8a93a0';

export function pinColor(type: string | undefined): string {
  if (!type) return PIN_DEFAULT;
  return PIN[type.toLowerCase()] ?? PIN_DEFAULT;
}

const CAT: Record<string, string> = {
  Constants: '#6b7886', Math: '#5b9bf0', Texture: '#4fb0a0',
  Coordinates: '#c98a52', Functions: '#a06bff', Parameters: '#d98ec0',
  Utility: '#8a93a0', Output: '#e8ebef',
};
const CAT_DEFAULT = '#6b7886';

export function catColor(cat: string | undefined): string {
  if (!cat) return CAT_DEFAULT;
  return CAT[cat] ?? CAT_DEFAULT;
}
