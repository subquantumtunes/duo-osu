const REPO = 'subquantumtunes/duo-osu'
const ASSET_NAME = 'dosu-Setup.exe'

type Release = { assets: { name: string; url: string }[] }

export async function GET() {
  const token = process.env.DOSU_RELEASES_TOKEN

  // Public repos can link straight to the latest release asset.
  if (!token) {
    return Response.redirect(`https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}`, 302)
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
    return new Response('The dosu installer is not available yet. Try again in a few minutes.', { status: 503 })
  }

  const release = (await releaseRes.json()) as Release
  const asset = release.assets.find((a) => a.name === ASSET_NAME)
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
