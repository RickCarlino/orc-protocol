// Minimal React type shims to allow offline typechecking without @types packages.
// When dev deps are installed, proper types from @types/react will override these.

declare module 'react' {
  export type FC<P = {}> = (props: P & { children?: any }) => any;
  export type FormEvent = any;
  export const useState: <T = any>(
    init?: T | (() => T)
  ) => [T, (v: T | ((prev: T) => T)) => void];
  export const useEffect: (fn: () => void | (() => void), deps?: any[]) => void;
  export const useMemo: <T>(factory: () => T, deps?: any[]) => T;
  export const useCallback: <T extends (...args: any[]) => any>(fn: T, deps?: any[]) => T;
  export const useRef: <T = any>(init?: T) => { current: T };
  const React: any;
  export default React;
}

declare module 'react-dom/client' {
  export const createRoot: (container: Element | DocumentFragment) => { render: (ui: any) => void };
}

declare module 'react/jsx-runtime' {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
}

declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}
