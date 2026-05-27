export interface CommentBoxData {
  text: string;
  color: string;
  bounds: { x: number; y: number; w: number; h: number };
}

export function CommentBoxOverlay({ comments }: { comments: CommentBoxData[] }) {
  return (
    <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', width: '100%', height: '100%' }}>
      {comments.map((c, i) => (
        <g key={i}>
          <rect
            x={c.bounds.x - 12} y={c.bounds.y - 28}
            width={c.bounds.w + 24} height={c.bounds.h + 40}
            fill={c.color + '20'} stroke={c.color} strokeWidth={2} rx={4}
          />
          <text x={c.bounds.x - 8} y={c.bounds.y - 12} fill={c.color} fontSize={12} fontWeight={600}>{c.text}</text>
        </g>
      ))}
    </svg>
  );
}
