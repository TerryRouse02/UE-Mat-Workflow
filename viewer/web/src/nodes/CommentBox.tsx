export interface CommentNodeData {
  text: string;
  color: string;
  width: number;
  height: number;
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
      <div style={{ color: data.color, fontSize: 12, fontWeight: 600 }}>{data.text}</div>
    </div>
  );
}
