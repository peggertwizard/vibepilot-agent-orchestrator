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
    /*
     * One test file at a time.
     *
     * Three files now spawn real Claude processes, and run in parallel they contend for the
     * same account: a turn that should take ten seconds returns immediately having done
     * nothing, and the test fails in 3ms with no useful message. That looked like flakiness
     * in `ask_user` and was actually the harness competing with itself.
     *
     * The cost is wall-clock — the suite is serial now — and that is the right trade for a
     * suite whose failures are supposed to mean something.
     */
    fileParallelism: false,
  },
})
