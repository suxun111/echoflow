export type Cue = {
  id: string
  start: number
  end: number
  text: string
}

export type AppView = 'home' | 'discover' | 'favorites' | 'history' | 'vocabulary' | 'uploads' | 'settings'

export type AuthUser = {
  id: string
  phone: string
  displayName: string
}

export type AuthSession = {
  accessToken: string
  refreshToken: string
  user: AuthUser
}

export type Course = {
  id: string
  title: string
  videoId: string
  videoUrl: string
  cues: Cue[]
  createdAt: string
  updatedAt: string
}

export type PracticeProgress = {
  courseId: string
  currentCueIndex: number
  completedCueIds: string[]
  loopEnabled: boolean
  updatedAt: string
}

export type Recording = {
  id: string
  courseId: string
  cueId: string
  blob: Blob
  mimeType: string
  createdAt: string
}
