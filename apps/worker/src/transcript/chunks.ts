export type AudioChunkPlan = { chunkIndex: number; startMs: number; endMs: number }

export function parseSilenceCenters(stderr: string) {
  const starts = [...stderr.matchAll(/silence_start:\s*([0-9.]+)/g)].map((match) => Number(match[1]) * 1000)
  const ends = [...stderr.matchAll(/silence_end:\s*([0-9.]+)/g)].map((match) => Number(match[1]) * 1000)
  return starts.flatMap((start, index) => Number.isFinite(ends[index]) && ends[index] >= start ? [(start + ends[index]) / 2] : [])
}

export function planAudioChunks(
  durationMs: number,
  targetMs: number,
  overlapMs: number,
  silenceCentersMs: number[],
): AudioChunkPlan[] {
  if (!Number.isInteger(durationMs) || durationMs <= 0 || targetMs < 60_000 || overlapMs < 0) throw new Error('invalid_chunk_plan')
  const boundaries = [0]
  let boundary = 0
  while (durationMs - boundary > Math.round(targetMs * 1.25)) {
    const desired = boundary + targetMs
    const candidate = silenceCentersMs
      .filter((value) => value >= desired - 30_000 && value <= desired + 30_000 && value - boundary >= 60_000)
      .sort((left, right) => Math.abs(left - desired) - Math.abs(right - desired))[0]
    const next = Math.round(candidate ?? desired)
    if (next <= boundary || next >= durationMs) break
    boundaries.push(next)
    boundary = next
  }
  boundaries.push(durationMs)
  return boundaries.slice(0, -1).map((start, chunkIndex) => ({
    chunkIndex,
    startMs: Math.max(0, start - (chunkIndex === 0 ? 0 : overlapMs)),
    endMs: Math.min(durationMs, boundaries[chunkIndex + 1] + (chunkIndex + 2 === boundaries.length ? 0 : overlapMs)),
  }))
}
