import React, { createContext, useContext, useReducer, useEffect } from 'react';
import { connect } from './ws-client';
import type { ServerMessage, GraphPayload } from './protocol';

interface State {
  files: string[];
  currentPath: string | null;
  breadcrumb: string[];
  graphs: Record<string, GraphPayload>;
  errors: Record<string, string[]>;
}

type Action =
  | { type: 'hello'; files: string[] }
  | { type: 'fileList'; files: string[] }
  | { type: 'graph'; path: string; payload: GraphPayload }
  | { type: 'graphError'; path: string; errors: string[] }
  | { type: 'open'; path: string }
  | { type: 'enterMF'; mfPath: string }
  | { type: 'popBreadcrumb'; toIndex: number };

const initial: State = {
  files: [], currentPath: null, breadcrumb: [], graphs: {}, errors: {},
};

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'hello':
    case 'fileList':
      return { ...s, files: a.files };
    case 'graph':
      return { ...s, graphs: { ...s.graphs, [a.path]: a.payload }, errors: { ...s.errors, [a.path]: [] } };
    case 'graphError':
      return { ...s, errors: { ...s.errors, [a.path]: a.errors } };
    case 'open':
      return { ...s, currentPath: a.path, breadcrumb: [a.path] };
    case 'enterMF':
      return { ...s, breadcrumb: [...s.breadcrumb, a.mfPath] };
    case 'popBreadcrumb':
      return { ...s, breadcrumb: s.breadcrumb.slice(0, a.toIndex + 1) };
    default: return s;
  }
}

interface Ctx {
  state: State;
  open(path: string): void;
  enterMF(path: string): void;
  popBreadcrumb(i: number): void;
}

const C = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const wsRef = React.useRef<ReturnType<typeof connect> | null>(null);

  useEffect(() => {
    const ws = connect((m: ServerMessage) => {
      if (m.kind === 'hello') dispatch({ type: 'hello', files: m.files });
      else if (m.kind === 'fileList') dispatch({ type: 'fileList', files: m.files });
      else if (m.kind === 'graph') dispatch({ type: 'graph', path: m.path, payload: m.payload });
      else if (m.kind === 'graphError') dispatch({ type: 'graphError', path: m.path, errors: m.errors });
    });
    wsRef.current = ws;
    return () => ws.close();
  }, []);

  return (
    <C.Provider value={{
      state,
      open(path) { wsRef.current?.send({ kind: 'open', path }); dispatch({ type: 'open', path }); },
      enterMF(path) { wsRef.current?.send({ kind: 'open', path }); dispatch({ type: 'enterMF', mfPath: path }); },
      popBreadcrumb(i) { dispatch({ type: 'popBreadcrumb', toIndex: i }); },
    }}>{children}</C.Provider>
  );
}

export function useStore() {
  const c = useContext(C);
  if (!c) throw new Error('useStore outside StoreProvider');
  return c;
}
