/**
 * Vite's `?raw` suffix, declared narrowly.
 *
 * `vite/client` would provide this, but it also declares every other asset suffix and a
 * global `import.meta.env` we do not use — a wide ambient type is how a renderer quietly
 * starts depending on things it never meant to. We inline exactly two SVGs; this is that.
 */
declare module '*.svg?raw' {
  const content: string
  export default content
}
