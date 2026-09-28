/**
 * Stable bundle entry.
 *
 * DSH's Cordis Loader imports a plugin with a plain `await import(name)` and no
 * cache-busting, so a module URL stays cached for the life of the process: editing the
 * host half and toggling the bundle re-runs `apply` on the *old* module.
 *
 * This entry therefore holds no logic. On every activation it imports the real
 * implementation under a fresh `?rev=` URL, so a bundle toggle always picks up the
 * current source — no DSH restart, and no need to rename files per release.
 *
 * `name` and `inject` stay static because the Loader reads them from the module before
 * calling `apply`.
 */

export const name = 'adp-console'

/** The tool registry is the only hard dependency; the HTTP route is optional. */
export const inject = ['tools']

/** Resolves once the current activation has loaded and applied the implementation. */
let ready = Promise.resolve(undefined)

/**
 * Load the implementation fresh and delegate activation to it.
 * @param ctx - the Host plugin context.
 * @param config - the row's raw config.
 */
export function apply(ctx, config) {
  let dispose
  let cancelled = false

  const load = async () => {
    const url = new URL('./impl.js', import.meta.url)
    // The query is what defeats the module cache; plain Node ESM treats a different
    // query string as a different module and re-evaluates it.
    url.searchParams.set('rev', String(Date.now()))
    const impl = await import(url.href)
    if (cancelled) return undefined
    dispose = await impl.apply(ctx, config)
    return dispose
  }

  ready = load().catch((error) => {
    console.error('[adp-console] 无法加载插件实现：', error)
    return undefined
  })

  ctx.effect(() => () => {
    cancelled = true
    if (typeof dispose === 'function') dispose()
  }, 'adp-console: implementation')

  return () => {
    cancelled = true
    if (typeof dispose === 'function') dispose()
  }
}

/**
 * Await the latest activation's implementation load.
 * Exposed for tests and diagnostics; the Loader itself never calls it.
 * @returns the displacement of the current load.
 */
export function whenReady() {
  return ready
}
