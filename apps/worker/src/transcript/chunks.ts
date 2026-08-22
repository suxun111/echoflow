export type AudioChunkPlan = { chunkIndex: number; startMs: number; endMs: number }
export type SilenceWindow = { startMs: number; endMs: number; centerMs: number; durationMs: number }
export type BoundaryRepairPlan = {
  previousChunkIndex: number
  nextChunkIndex: number
  originalBoundaryMs: number
  replacementBoundaryMs: number
  replacementChunks: [AudioChunkPlan, AudioChunkPlan]
}

export function parseSilenceWindows(stderr: string): SilenceWindow[] {
  const starts = [...stderr.matchAll(/silence_start:\s*([0-9.]+)/g)].map((match) => Number(match[1]) * 1000)
  const ends = [...stderr.matchAll(/silence_end:\s*([0-9.]+)/g)].map((match) => Number(match[1]) * 1000)
  return starts.flatMap((start, index) => {
    const end = ends[index]
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return []
    const startMs = Math.round(start)
    const endMs = Math.round(end)
    return [{ startMs, endMs, centerMs: Math.round((startMs + endMs) / 2), durationMs: endMs - startMs }]
  })
}

export function parseSilenceCenters(stderr: string) {
  return parseSilenceWindows(stderr).map((window) => window.centerMs)
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

export function planBoundaryRepair(
  chunks: AudioChunkPlan[],
  previousChunkIndex: number,
  durationMs: number,
  overlapMs: number,
  silenceWindows: SilenceWindow[],
): BoundaryRepairPlan | null {
  if (!Number.isInteger(durationMs) || durationMs <= 0 || !Number.isInteger(overlapMs) || overlapMs < 0
    || previousChunkIndex < 0 || previousChunkIndex + 1 >= chunks.length) return null
  const sorted = chunks.slice().sort((left, right) => left.chunkIndex - right.chunkIndex)
  if (sorted.some((chunk, index) => chunk.chunkIndex !== index
    || chunk.startMs < 0 || chunk.endMs <= chunk.startMs || chunk.endMs > durationMs)) return null
  const previous = sorted[previousChunkIndex]
  const next = sorted[previousChunkIndex + 1]
  if (previous.endMs < next.startMs) return null
  const originalBoundaryMs = Math.round((previous.endMs + next.startMs) / 2)
  const minimumShiftMs = Math.max(1_000, overlapMs)
  const candidate = silenceWindows
    .filter((window) => window.durationMs > 0
      && Math.abs(window.centerMs - originalBoundaryMs) >= minimumShiftMs
      && window.centerMs >= originalBoundaryMs - 30_000
      && window.centerMs <= originalBoundaryMs + 30_000
      && window.centerMs - overlapMs > previous.startMs
      && window.centerMs + overlapMs < next.endMs)
    .sort((left, right) => right.durationMs - left.durationMs
      || Math.abs(left.centerMs - originalBoundaryMs) - Math.abs(right.centerMs - originalBoundaryMs)
      || left.centerMs - right.centerMs)[0]
  if (!candidate) return null
  const replacementBoundaryMs = candidate.centerMs
  const replacementChunks: [AudioChunkPlan, AudioChunkPlan] = [
    { ...previous, endMs: Math.min(durationMs, replacementBoundaryMs + overlapMs) },
    { ...next, startMs: Math.max(0, replacementBoundaryMs - overlapMs) },
  ]
  if (replacementChunks.some((chunk) => chunk.endMs <= chunk.startMs)
    || replacementChunks[0].endMs < replacementChunks[1].startMs) return null
  return {
    previousChunkIndex,
    nextChunkIndex: previousChunkIndex + 1,
    originalBoundaryMs,
    replacementBoundaryMs,
    replacementChunks,
  }
}
