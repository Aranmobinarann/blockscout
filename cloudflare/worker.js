addEventListener('fetch', event => {
  // pass the event so we can use event.waitUntil inside the handler
  event.respondWith(handleRequest(event.request, event))
})

// Simple Cloudflare Worker to proxy and cache NFT media from R2 public URL
// Configure R2_PUBLIC_URL to point to your public R2 bucket root, e.g.
// https://<account_id>.r2.cloudflarestorage.com/<bucket>

async function handleRequest(request, event) {
  // allow only safe methods
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { 'Allow': 'GET, HEAD' } })
  }

  const url = new URL(request.url)
  // expect path like /nft/<key> or /media/<key>
  let key = url.pathname.replace(/^\/(nft|media)\/?/, '')
  key = key.replace(/^\/+|\/+$/g, '') // trim slashes
  if (!key) return new Response('Not Found', { status: 404 })

  // restrict/sanitize key length and segments to avoid abuse
  if (key.length > 2000) return new Response('Key too long', { status: 400 })
  const encodedKey = key.split('/').map(encodeURIComponent).join('/')

  const r2PublicUrl = R2_PUBLIC_URL || 'https://your_account_id.r2.cloudflarestorage.com/your_bucket'
  const fetchUrl = `${r2PublicUrl}/${encodedKey}`

  const cache = caches.default
  // create a cache key that is always a GET for the resource URL (don't copy original request)
  const cacheKey = new Request(fetchUrl, { method: 'GET' })

  try {
    const cached = await cache.match(cacheKey)
    if (cached) {
      // Serve cached immediately, and refresh in background (stale-while-revalidate)
      event.waitUntil((async () => {
        try {
          // If we have an ETag on the cached response, use conditional request
          const etag = cached.headers.get('ETag')
          const conditionalHeaders = etag ? { 'If-None-Match': etag } : {}
          const fresh = await fetch(fetchUrl, {
            method: 'GET',
            headers: conditionalHeaders,
            cf: { cacheTtl: 1209600 }
          })
          if (fresh.status === 304) {
            // origin says content unchanged — update metadata in cache by re-putting cached
            await cache.put(cacheKey, cached.clone())
            return
          }
          if (fresh.ok) {
            const headers = new Headers(fresh.headers)
            headers.set('Cache-Control', 'public, max-age=31536000, immutable')
            // Optionally add CORS for public media
            headers.set('Access-Control-Allow-Origin', '*')
            await cache.put(cacheKey, new Response(fresh.body, { status: fresh.status, statusText: fresh.statusText, headers }).clone())
          }
        } catch (err) {
          // background refresh failed - ignore but could report/log to analytics
        }
      })())
      return cached
    }

    // Not in cache — fetch from origin
    const originResp = await fetch(fetchUrl, { method: 'GET', cf: { cacheTtl: 1209600 }, redirect: 'follow' })
    if (!originResp.ok) return new Response('Not Found', { status: originResp.status })

    const headers = new Headers(originResp.headers)
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    headers.set('Access-Control-Allow-Origin', '*')

    const newResp = new Response(originResp.body, { status: originResp.status, statusText: originResp.statusText, headers })
    // store in cache in background
    event.waitUntil(cache.put(cacheKey, newResp.clone()))
    return newResp

  } catch (err) {
    // On unexpected errors, try to fall back to cache
    const fallback = await cache.match(cacheKey)
    if (fallback) return fallback
    return new Response('Bad Gateway', { status: 502 })
  }
}
