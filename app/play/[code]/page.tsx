import type { Metadata } from 'next'
import { GuestRoom } from '@/components/guest/guest-room'
import { normalizeRoomCode } from '@/lib/protocol'

export const metadata: Metadata = {
  title: 'Join — duosu',
  description: 'Watch your partner’s osu! game and play your half of the controls.',
}

export default async function PlayPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  return <GuestRoom code={normalizeRoomCode(code)} />
}
