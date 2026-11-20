const REPO = 'subquantumtunes/duo-osu'
const ASSET_NAME = 'duosu-Setup.exe'
const LEGACY_ASSET_NAME = 'dosu-Setup.exe'

type Release = { assets: { name: string; url: string; browser_download_url: string }[] }

function pickInstaller(release: Release) {
  // Releases built before the rename still ship the old installer name.
  return (
    release.assets.find((a) => a.name === ASSET_NAME) ?? release.assets.find((a) => a.name === LEGACY_ASSET_NAME)
  )
}

export async function GET() {
  const token = process.env.DOSU_RELEASES_TOKEN

  if (!token) {
    const releaseRes = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      next: { revalidate: 300 },
    }).catch(() => null)
    const asset = releaseRes?.ok ? pickInstaller((await releaseRes.json()) as Release) : undefined
    const url = asset?.browser_download_url ?? `https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}`
    return Response.redirect(url, 302)
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }

  const releaseRes = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { ...headers, Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  })
  if (!releaseRes.ok) {
    return new Response('The duosu installer is not available yet. Try again in a few minutes.', { status: 503 })
  }

  const asset = pickInstaller((await releaseRes.json()) as Release)
  if (!asset) {
    return new Response('The latest release has no installer attached yet.', { status: 404 })
  }

  // GitHub answers with a short-lived signed URL; send the browser there so the
  // file never streams through this function.
  const assetRes = await fetch(asset.url, {
    headers: { ...headers, Accept: 'application/octet-stream' },
    redirect: 'manual',
    cache: 'no-store',
  })
  const location = assetRes.headers.get('location')
  if (!location) {
    return new Response('Could not prepare the download.', { status: 502 })
  }

  return Response.redirect(location, 302)
}
