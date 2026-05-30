import { getBaseUri } from '@/shared/http-client'

export function downloadFileByBlob(data: ArrayBuffer, fileName: string, mimeType = 'text/plain') {
  if (!data) {
    throw new Error('No data to download')
  }
  const blob = new Blob([data], { type: mimeType })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = fileName
  link.click()
  URL.revokeObjectURL(link.href)
}

/**
 * Hand a URL to the browser to download natively (parallel, with the browser's
 * own progress, surviving SPA navigation). The server sets Content-Disposition
 * so the filename comes from the response, not the link. Use for ticketed /
 * already-authorized URLs.
 */
export function triggerBrowserDownload(url: string) {
  const link = document.createElement('a')
  link.href = url
  link.rel = 'noopener'
  // Hint the browser to download rather than navigate; the server's
  // Content-Disposition is authoritative for the actual filename.
  link.setAttribute('download', '')
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export async function downloadFileByUrl(url: string, fileName: string) {
  const apiBase = await getBaseUri()
  const isAbsolute =
    url.indexOf('http://') === 0 || url.indexOf('https://') === 0
  const finalUrl = isAbsolute ? url : `${apiBase}/${url}`
  const link = document.createElement('a')
  link.href = finalUrl
  link.download = fileName
  link.click()
  URL.revokeObjectURL(link.href)
}
