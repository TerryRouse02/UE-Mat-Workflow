import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function CommentBoxOverlay({ comments }) {
    return (_jsx("svg", { style: { position: 'absolute', inset: 0, pointerEvents: 'none', width: '100%', height: '100%' }, children: comments.map((c, i) => (_jsxs("g", { children: [_jsx("rect", { x: c.bounds.x - 12, y: c.bounds.y - 28, width: c.bounds.w + 24, height: c.bounds.h + 40, fill: c.color + '20', stroke: c.color, strokeWidth: 2, rx: 4 }), _jsx("text", { x: c.bounds.x - 8, y: c.bounds.y - 12, fill: c.color, fontSize: 12, fontWeight: 600, children: c.text })] }, i))) }));
}
