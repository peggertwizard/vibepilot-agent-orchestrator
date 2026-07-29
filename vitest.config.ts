import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    react(),
    {
      // `node:sqlite` landed after Vite 5's list of Node builtins, so Vite tries to bundle
      // it and fails to resolve. Mark it external so it reaches Node untouched.
      name: 'externalize-node-sqlite',
      enforce: 'pre',
      resolveId(id: string) {
        if (id === 'node:sqlite' || id === 'sqlite') {
          return { id: 'node:sqlite', external: true }
        }
        return null
      },
    },
  ],
  resolve: {
    alias: {
      // The main process modules import `electron` for userData paths. Under test we
      // substitute a stub that points at a temp directory, so repos and the MCP server can
      // be exercised for real without an Electron runtime.
      electron: resolve('tests/stubs/electron.ts'),
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
    },
  },
  test: {
    // `node:sqlite` is isBuiltin() true but missing from `builtinModules` because it is
    // still flagged experimental, so Vite's auto-externalizer does not catch it.
    server: { deps: { external: [/^node:sqlite$/] } },
    // .tsx too: the markdown renderer is the one place untrusted model output reaches the
    // DOM, and its tests render real React.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // The integration test spawns a real claude process; the cold start alone is ~5s.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
})
