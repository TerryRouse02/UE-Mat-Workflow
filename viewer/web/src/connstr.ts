// A connection endpoint is the string "nodeId:pinName". Split on the FIRST
// colon: the node id is everything before it, the pin name everything after.
// Node ids may not contain ':' (it is the delimiter — enforced in validation),
// so the first colon is always the id/pin boundary. Splitting this way is
// unambiguous and never silently drops a trailing segment the way a plain
// `str.split(':')` destructure does.
export function splitRef(ref: string): [nodeId: string, pinName: string] {
  const i = ref.indexOf(':');
  if (i < 0) return [ref, ''];
  return [ref.slice(0, i), ref.slice(i + 1)];
}
