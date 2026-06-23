/**
 * Settings → License: shows the license this build of Reliquary is distributed
 * under, bundled at build time (so it always matches the running version) and
 * read-only. Updating to a newer version surfaces that version's license for
 * acceptance separately (see LicenseGate).
 */

import { useEffect, useState } from 'react'
import licenseText from '@root/LICENSE?raw'

export function LicenseCard(): React.JSX.Element {
  const [version, setVersion] = useState('')
  useEffect(() => {
    void window.reliquary.getVersion().then(setVersion)
  }, [])

  return (
    <div>
      <h3 className="text-[15px] font-semibold text-hi">Your license</h3>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-mid">
        Reliquary <span className="font-mono text-hi">v{version || '—'}</span> is licensed under{' '}
        <span className="font-medium text-hi">PolyForm Noncommercial 1.0.0</span> — free for personal,
        non-commercial use. Commercial use requires a separate license from the copyright holder.
      </p>
      <div className="mt-4 max-h-[46vh] select-text overflow-y-auto whitespace-pre-wrap rounded-2xl border border-edge bg-void-1 p-4 font-mono text-[11.5px] leading-relaxed text-mid">
        {licenseText}
      </div>
    </div>
  )
}
