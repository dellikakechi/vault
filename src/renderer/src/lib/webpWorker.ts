/**
 * Off-main-thread lossless WebP encoder. Keeps the conversion progress dock
 * responsive while libwebp works on large pages.
 */
import { encodeLossless } from './webpEncoder'

interface EncodeRequest {
  id: number
  width: number
  height: number
  data: ArrayBuffer
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<EncodeRequest>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

scope.onmessage = async (event) => {
  const { id, width, height, data } = event.data
  try {
    const image = new ImageData(new Uint8ClampedArray(data), width, height)
    const encoded = await encodeLossless(image)
    scope.postMessage({ id, data: encoded }, [encoded])
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
