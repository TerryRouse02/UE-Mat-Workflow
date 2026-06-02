export interface CommentNodeData {
  text: string;
  color: string;
  width: number;
  height: number;
}

// Comment boxes sit on the dark canvas. A dark comment colour (UE materials
// often use pure black) renders its label invisible. Keep the author's colour
// for the title when it is bright enough to read; otherwise fall back to a
// light tone so the text is never lost. The border/background still carry the
// original colour so the author's grouping intent is preserved.
function readableText(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum < 0.45 ? '#e6e6e6' : hex;
}

export function CommentNode({ data }: { data: CommentNodeData }) {
  return (
    <div
      style={{
        width: data.width,
        height: data.height,
        background: data.color + '20',
        border: `2px solid ${data.color}`,
        borderRadius: 4,
        padding: '6px 12px',
        pointerEvents: 'none',
      }}
    >
      <div style={{ color: readableText(data.color), fontSize: 12, fontWeight: 600 }}>{data.text}</div>
    </div>
  );
}
