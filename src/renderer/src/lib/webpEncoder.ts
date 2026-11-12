/**
 * True lossless WebP encoding through libwebp (WASM).
 *
 * Chromium's canvas encoder only exposes lossy WebP, so the converter uses the
 * same libwebp build Squoosh ships. The wasm binary is served by the main
 * process under `vault://w/` so it works in both the dev server and packaged
 * file:// builds.
 */

/*
 * `method` only trades encoder time for a smaller file; every value below
 * produces bit-exact lossless output. On a 760x1080 comic page:
 *
 *   method 6 -> 5,670 ms, 239 KB (244,378 B)
 *   method 5 -> 1,162 ms, 254 KB (260,274 B)
 *   method 4 ->   812 ms, 259 KB (264,720 B)
 *   method 3 ->   931 ms, 264 KB (270,764 B)
 *
 * 5 keeps the long tail of a full-library run reasonable while staying close
 * to the best compression.
 */
export const LOSSLESS_OPTIONS = {
  lossless: 1,
  quality: 100,
  method: 5,
  exact: 1,
  near_lossless: 100,
  alpha_quality: 100
} as const

let ready: Promise<void> | null = null

async function initEncoder(): Promise<void> {
  const [{ simd }, { init }] = await Promise.all([
    import('wasm-feature-detect'),
    import('@jsquash/webp/encode')
  ])
  const isSimd = await simd()
  const wasm = isSimd ? 'vault://w/webp_enc_simd.wasm' : 'vault://w/webp_enc.wasm'
  await init({ locateFile: () => wasm })
}

export async function encodeLossless(image: ImageData): Promise<ArrayBuffer> {
  if (!ready) ready = initEncoder()
  await ready
  const { default: encode } = await import('@jsquash/webp/encode')
  return await encode(image, LOSSLESS_OPTIONS)
}
