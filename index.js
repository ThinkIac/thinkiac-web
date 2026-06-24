import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const PKG_DIR = dirname(fileURLToPath(import.meta.url))

// ── Environment detection ─────────────────────────────────────────────────────

let _mode = null

async function detectMode() {
  if (_mode) return _mode
  try {
    await import('puppeteer')
    _mode = 'puppeteer'
  } catch {
    try {
      await import('puppeteer-core')
      _mode = 'puppeteer'
    } catch {
      _mode = 'fetch'
    }
  }
  console.log(`[web] mode: ${_mode}`)
  return _mode
}

// ── Text extraction from HTML ─────────────────────────────────────────────────

function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20000)
}

function extractMeta(html) {
  const title  = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null
  const desc   = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1]?.trim() ?? null
  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i)?.[1]?.trim() ?? null
  return { title, description: desc, canonical }
}

// ── Fetch mode ────────────────────────────────────────────────────────────────

async function fetchPage(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Aurora/1.0)',
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(options.timeout ?? 15000),
  })

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)

  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return { type: 'json', data: await res.json(), url }
  }

  const html = await res.text()
  const meta = extractMeta(html)
  const text = extractText(html)
  return { type: 'html', ...meta, text, url, mode: 'fetch' }
}

// ── Puppeteer mode ────────────────────────────────────────────────────────────

async function puppeteerPage(url, options = {}) {
  let puppeteer
  try { puppeteer = await import('puppeteer') }
  catch { puppeteer = await import('puppeteer-core') }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (compatible; Aurora/1.0)')
    await page.goto(url, { waitUntil: 'networkidle2', timeout: options.timeout ?? 20000 })

    if (options.wait_selector) {
      await page.waitForSelector(options.wait_selector, { timeout: 5000 }).catch(() => {})
    }

    const html  = await page.content()
    const title = await page.title()
    const text  = extractText(html)
    const meta  = extractMeta(html)

    return { type: 'html', ...meta, title: title || meta.title, text, url, mode: 'puppeteer' }
  } finally {
    await browser.close()
  }
}

// ── Tool: web_fetch ───────────────────────────────────────────────────────────

export async function web_fetch(payload, context) {
  /**
   * @register_tool web_fetch
   * @description Fetches a URL and returns clean text content. Auto-detects fetch vs Puppeteer based on environment.
   * @param {string} url - The URL to fetch
   * @param {string?} mode - Force mode: "fetch" or "puppeteer"
   * @param {string?} wait_selector - CSS selector to wait for (puppeteer only)
   * @param {number?} timeout - Timeout in ms (default 15000)
   */
  if (!payload?.url) return { success: false, error: 'url is required' }

  const mode = payload.mode ?? await detectMode()

  try {
    const result = mode === 'puppeteer'
      ? await puppeteerPage(payload.url, payload)
      : await fetchPage(payload.url, payload)
    return { success: true, ...result }
  } catch (e) {
    // Fallback: if puppeteer fails, try fetch
    if (mode === 'puppeteer') {
      try {
        const result = await fetchPage(payload.url, payload)
        return { success: true, ...result, fallback: true }
      } catch {}
    }
    return { success: false, error: e.message, url: payload.url }
  }
}

// ── Tool: web_search ─────────────────────────────────────────────────────────

export async function web_search(payload, context) {
  /**
   * @register_tool web_search
   * @description Searches the web using DuckDuckGo and returns top results with title, url and snippet.
   * @param {string} query - Search query
   * @param {number?} limit - Max results (default 5)
   */
  if (!payload?.query) return { success: false, error: 'query is required' }

  const limit = payload.limit ?? 5
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(payload.query)}`

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Aurora/1.0)' },
      signal: AbortSignal.timeout(10000),
    })
    const html = await res.text()

    const results = []
    const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g
    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([^<]+)<\/a>/g

    const links   = [...html.matchAll(resultRegex)].slice(0, limit)
    const snippets = [...html.matchAll(snippetRegex)].slice(0, limit)

    for (let i = 0; i < links.length; i++) {
      const rawUrl = links[i][1]
      const title  = links[i][2].trim()
      const snippet = snippets[i]?.[1]?.trim() ?? ''
      // DDG uses redirect URLs — extract actual URL
      const actualUrl = rawUrl.startsWith('//duckduckgo.com/l/?')
        ? decodeURIComponent(rawUrl.match(/uddg=([^&]+)/)?.[1] ?? rawUrl)
        : rawUrl
      results.push({ title, url: actualUrl, snippet })
    }

    return { success: true, query: payload.query, results }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// ── Boot: detect and log mode ─────────────────────────────────────────────────

export async function onBoot(payload, context) {
  /**
   * @register_hook boot
   */
  await detectMode()
}
