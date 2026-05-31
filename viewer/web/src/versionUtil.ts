// UE version strings are "major.minor" (e.g. "5.7", "5.10"). Compare them
// NUMERICALLY per component — a plain string sort would wrongly order
// "5.10" before "5.7".
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Highest version in the list, or undefined if the list is empty.
export function latestOf(versions: string[]): string | undefined {
  if (versions.length === 0) return undefined;
  return [...versions].sort(compareVersions)[versions.length - 1];
}
