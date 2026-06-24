/**
 * Transport-aware media URL resolution for the UI.
 *
 * HTTP connections expose media at a direct, content-addressed URL the browser
 * fetches itself — returned synchronously (no flash, no extra fetch). RTC
 * connections may have no reachable HTTP port, so the bytes are fetched over the
 * data channel and wrapped in a cached `blob:` URL (KeepConnection.mediaSrc);
 * the hook returns '' until that resolves, then the blob URL.
 *
 * `download` is the URL to hand a download anchor: over HTTP it carries the
 * filename via a query param (server sets Content-Disposition); over RTC the
 * blob URL is reused and the anchor's own `download` attribute names the file.
 */

import { useEffect, useState } from 'react'
import { getKeep } from '@/net/bind'

export interface MediaUrls {
  src: string
  download: string
}

export function useMedia(instanceId: string, hash: string, name = ''): MediaUrls {
  const conn = getKeep(instanceId)
  const isRtc = conn?.transport === 'rtc'

  // HTTP: resolve synchronously every render.
  const directSrc = conn && !isRtc && hash ? conn.mediaUrl(hash) : ''
  const directDl = conn && !isRtc && hash ? conn.mediaDownloadUrl(hash, name) : directSrc

  // RTC: fetch the blob URL once, asynchronously.
  const [blob, setBlob] = useState('')
  useEffect(() => {
    if (!conn || conn.transport !== 'rtc' || !hash) {
      setBlob('')
      return
    }
    let alive = true
    void conn
      .mediaSrc(hash)
      .then((u) => {
        if (alive) setBlob(u)
      })
      .catch(() => {
        if (alive) setBlob('')
      })
    return () => {
      alive = false
    }
    // conn persists across rtc reconnects (only the transport rebuilds), so the
    // instance + hash are the stable identity here.
  }, [instanceId, hash, isRtc])

  if (isRtc) return { src: blob, download: blob }
  return { src: directSrc, download: directDl }
}
