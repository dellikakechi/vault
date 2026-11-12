import { protocol, app } from 'electron'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { Library } from './library'
import { MEDIA_EXT } from './library'

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg',
  '.wmv': 'video/x-ms-wmv',
  '.wasm': 'application/wasm'
}

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/** Must be called before app.whenReady(). */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'vault',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true
      }
    }
  ])
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return null
  let start: number
  let end: number
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end }
}

async function serveFile(file: string, request: Request): Promise<Response> {
  let stat
  try {
    stat = await fs.stat(file)
  } catch {
    return new Response('Not found', { status: 404 })
  }
  if (!stat.isFile()) return new Response('Not a file', { status: 404 })
  const size = stat.size
  const type = mimeFor(file)
  const range = parseRange(request.headers.get('range'), size)
  const isThumb = file.includes(`${path.sep}thumbs${path.sep}`)

  const baseHeaders: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': isThumb ? 'public, max-age=31536000, immutable' : 'no-cache'
  }

  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(size) }
    })
  }

  if (range) {
    const stream = createReadStream(file, { start: range.start, end: range.end })
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`
      }
    })
  }

  const stream = createReadStream(file)
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(size) }
  })
}

function decodePath(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf8')
}

export function encodePath(p: string): string {
  return Buffer.from(p, 'utf8').toString('base64url')
}

export function installProtocol(getLibrary: () => Library | null): void {
  protocol.handle('vault', async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    const lib = getLibrary()

    // vault://t/<itemId>  -> library thumbs
    if (url.hostname === 't') {
      if (!lib) return new Response('No library', { status: 503 })
      const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!/^[\w-]+$/.test(id)) return new Response('Bad id', { status: 400 })
      return serveFile(path.join(lib.thumbsDir, `${id}.webp`), request)
    }

    // vault://m/<base64url(relative-or-absolute path)>
    if (url.hostname === 'm') {
      if (!lib) return new Response('No library', { status: 503 })
      const encoded = url.pathname.replace(/^\//, '')
      let target: string
      try {
        target = decodePath(encoded)
      } catch {
        return new Response('Bad path', { status: 400 })
      }
      const ext = path.extname(target).toLowerCase()
      if (!MEDIA_EXT[ext]) return new Response('Unsupported type', { status: 415 })
      const abs = path.isAbsolute(target) ? target : path.resolve(lib.root, target)
      if (!path.isAbsolute(target)) {
        const root = path.resolve(lib.root)
        if (!abs.startsWith(root + path.sep) && abs !== root) {
          return new Response('Forbidden', { status: 403 })
        }
      }
      return serveFile(abs, request)
    }

    // vault://a/<base64url(absolute path)> — staging access for files being imported
    if (url.hostname === 'a') {
      const target = decodePath(url.pathname.replace(/^\//, ''))
      if (!path.isAbsolute(target)) return new Response('Bad path', { status: 400 })
      if (!MEDIA_EXT[path.extname(target).toLowerCase()]) {
        return new Response('Unsupported type', { status: 415 })
      }
      return serveFile(target, request)
    }

    // vault://w/webp_enc[_simd].wasm — WebAssembly codec used by the converter.
    // Serving it through this scheme keeps fetch working in both the dev server
    // and the packaged file:// renderer.
    if (url.hostname === 'w') {
      const name = url.pathname.replace(/^\//, '')
      if (name !== 'webp_enc_simd.wasm' && name !== 'webp_enc.wasm') {
        return new Response('Not found', { status: 404 })
      }
      const file = app.isPackaged
        ? path.join(process.resourcesPath, name)
        : path.join(app.getAppPath(), 'node_modules', '@jsquash', 'webp', 'codec', 'enc', name)
      return serveFile(file, request)
    }

    return new Response('Unknown resource', { status: 404 })
  })
}
