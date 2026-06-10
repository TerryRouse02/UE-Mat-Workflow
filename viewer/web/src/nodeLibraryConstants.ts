// Node library display constants — pin-type dot colours and category colours.
// COLOUR RULE (D2): these use the app's EXISTING palette from theme/colors.ts,
// NOT the mockup's brighter colours. The canvas stays visually unchanged.

import { pinColor, catColor } from './theme/colors';

// Normalise DB pin-type strings to a canonical colour.
// DB uses: Float1, Float2, Float3, Float4, Float1|2|3|4, Texture2D,
//          MaterialAttributes, Bool, matchInput, etc.
// The pinColor() lookup from theme/colors handles lowercase keys
// (float, float1..4, texture, bool, materialattributes, scalar, …).
export function mapPinTypeColor(type: string): string {
  const lc = type.toLowerCase();

  // Handle multi-type strings like "Float1|2|3|4" → treat as float4
  if (lc.includes('|')) return pinColor('float4');

  // Direct mappings
  if (lc === 'texture2d' || lc === 'textureorobject' || lc.startsWith('texture'))
    return pinColor('texture');
  if (lc === 'materialattributes' || lc === 'materialattribute')
    return pinColor('materialattributes');
  if (lc === 'bool' || lc === 'boolean') return pinColor('bool');
  if (lc === 'float1' || lc === 'scalar') return pinColor('float1');
  if (lc === 'float2') return pinColor('float2');
  if (lc === 'float3') return pinColor('float3');
  if (lc === 'float4') return pinColor('float4');
  if (lc === 'float') return pinColor('float');

  // matchInput / passthrough / unknown → default grey
  return pinColor(lc);
}

// Category colour for the node-type dot.
export function mapCatColor(category: string | undefined): string {
  return catColor(category);
}
