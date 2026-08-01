export type LibraryVideo = {
  id: string
  title: string
  subtitle: string
  creator: string
  level: 'A1' | 'A2' | 'B1' | 'B2' | 'C1'
  category: '旅行' | '日常' | '文化' | '职场' | '发音'
  accent: '英音' | '美音' | '澳音'
  duration: string
  learners: string
  cover: string
  color: string
  progress?: number
  featured?: boolean
}

export type LearningCue = {
  id: string
  start: number
  end: number
  english: string
  chinese: string
  highlight?: string[]
  wordTranslations: WordTranslation[]
}

export type WordTranslation = {
  // Preserve the surface form used in the cue so repeated words can carry contextual meanings.
  word: string
  translation: string
}

const englishSurfaceWordPattern = /[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+(?:['’][A-Za-z]+)*)*/g

export function getEnglishSurfaceWords(text: string) {
  return text.match(englishSurfaceWordPattern) ?? []
}

export const libraryVideos: LibraryVideo[] = [
  {
    id: 'british-coast',
    title: '英国海滨小镇的一天',
    subtitle: 'Life in a British Coastal Town',
    creator: 'Evie English',
    level: 'A2',
    category: '旅行',
    accent: '英音',
    duration: '08:42',
    learners: '2.8k',
    cover: 'https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?auto=format&fit=crop&w=1200&q=85',
    color: '#7457ea',
    progress: 38,
    featured: true,
  },
  {
    id: 'morning-routine',
    title: '我的伦敦晨间日常',
    subtitle: 'My Slow Morning in London',
    creator: 'Mia Abroad',
    level: 'A1',
    category: '日常',
    accent: '英音',
    duration: '06:18',
    learners: '4.3k',
    cover: 'https://images.unsplash.com/photo-1511081692775-05d0f180a065?auto=format&fit=crop&w=1200&q=85',
    color: '#f39b64',
  },
  {
    id: 'new-york-coffee',
    title: '在纽约点一杯咖啡',
    subtitle: 'How to Order Coffee Naturally',
    creator: 'Speak Easy',
    level: 'A2',
    category: '日常',
    accent: '美音',
    duration: '05:26',
    learners: '3.1k',
    cover: 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=1200&q=85',
    color: '#21a67a',
  },
  {
    id: 'scotland-train',
    title: '坐火车穿越苏格兰',
    subtitle: 'A Beautiful Train Journey',
    creator: 'Wander English',
    level: 'B1',
    category: '旅行',
    accent: '英音',
    duration: '12:04',
    learners: '1.9k',
    cover: 'https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&fit=crop&w=1200&q=85',
    color: '#3f7fc5',
  },
  {
    id: 'small-talk',
    title: '五个自然开启对话的方法',
    subtitle: 'Start a Conversation Naturally',
    creator: 'Rachel Talks',
    level: 'B1',
    category: '职场',
    accent: '美音',
    duration: '09:15',
    learners: '6.7k',
    cover: 'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=1200&q=85',
    color: '#e8677d',
  },
  {
    id: 'australia-roadtrip',
    title: '澳洲公路旅行实用英语',
    subtitle: 'English for an Aussie Road Trip',
    creator: 'Sunny English',
    level: 'B2',
    category: '旅行',
    accent: '澳音',
    duration: '14:32',
    learners: '1.4k',
    cover: 'https://images.unsplash.com/photo-1523482580672-f109ba8cb9be?auto=format&fit=crop&w=1200&q=85',
    color: '#e38b35',
  },
  {
    id: 'connected-speech',
    title: '听懂英语中的连读',
    subtitle: 'Master Connected Speech',
    creator: 'Clear English Lab',
    level: 'B2',
    category: '发音',
    accent: '美音',
    duration: '10:48',
    learners: '5.2k',
    cover: 'https://images.unsplash.com/photo-1475721027785-f74eccf877e2?auto=format&fit=crop&w=1200&q=85',
    color: '#5866d9',
  },
  {
    id: 'museum-story',
    title: '大英博物馆里的故事',
    subtitle: 'Stories Inside the British Museum',
    creator: 'Culture Walks',
    level: 'C1',
    category: '文化',
    accent: '英音',
    duration: '16:20',
    learners: '980',
    cover: 'https://images.unsplash.com/photo-1564399579883-451a5d44ec08?auto=format&fit=crop&w=1200&q=85',
    color: '#9c704d',
  },
]

export const learningCues: LearningCue[] = [
  {
    id: '1', start: 2, end: 5,
    english: 'Welcome back to another slow English video.', chinese: '欢迎回到又一期慢速英语视频。',
    highlight: ['Welcome', 'slow English'],
    wordTranslations: [
      { word: 'Welcome', translation: '欢迎' }, { word: 'back', translation: '回来' },
      { word: 'to', translation: '到；向' }, { word: 'another', translation: '另一；又一' },
      { word: 'slow', translation: '慢速的' }, { word: 'English', translation: '英语' },
      { word: 'video', translation: '视频' },
    ],
  },
  {
    id: '2', start: 5, end: 9,
    english: 'Today, I am taking you around my little coastal town.', chinese: '今天，我会带你逛逛我居住的海滨小镇。',
    highlight: ['taking you around', 'coastal town'],
    wordTranslations: [
      { word: 'Today', translation: '今天' }, { word: 'I', translation: '我' },
      { word: 'am', translation: '是；正在（与 taking 构成进行时）' }, { word: 'taking', translation: '带着；正带' },
      { word: 'you', translation: '你' }, { word: 'around', translation: '四处；到处' },
      { word: 'my', translation: '我的' }, { word: 'little', translation: '小的' },
      { word: 'coastal', translation: '沿海的' }, { word: 'town', translation: '小镇' },
    ],
  },
  {
    id: '3', start: 9, end: 13,
    english: 'It is a quiet place, but there is always something to see.', chinese: '这里很安静，但总有值得一看的地方。',
    highlight: ['quiet place', 'something to see'],
    wordTranslations: [
      { word: 'It', translation: '这里；它' }, { word: 'is', translation: '是' },
      { word: 'a', translation: '一个' }, { word: 'quiet', translation: '安静的' },
      { word: 'place', translation: '地方' }, { word: 'but', translation: '但是' },
      { word: 'there', translation: '那里；用于 there is 表示“有”' }, { word: 'is', translation: '有；是' },
      { word: 'always', translation: '总是' }, { word: 'something', translation: '某件事；某个东西' },
      { word: 'to', translation: '用来；不定式标志' }, { word: 'see', translation: '看见；观看' },
    ],
  },
  {
    id: '4', start: 13, end: 17,
    english: 'We will start at the harbour and walk towards the old market.', chinese: '我们会从港口出发，走向老市场。',
    highlight: ['harbour', 'towards'],
    wordTranslations: [
      { word: 'We', translation: '我们' }, { word: 'will', translation: '将会' },
      { word: 'start', translation: '开始；出发' }, { word: 'at', translation: '在；从' },
      { word: 'the', translation: '这个；那个（特指）' }, { word: 'harbour', translation: '港口；港湾' },
      { word: 'and', translation: '和；并且' }, { word: 'walk', translation: '走；步行' },
      { word: 'towards', translation: '朝；向' }, { word: 'the', translation: '那个（特指）' },
      { word: 'old', translation: '老的；旧的' }, { word: 'market', translation: '市场' },
    ],
  },
  {
    id: '5', start: 17, end: 21,
    english: 'On sunny days, people sit outside with coffee and watch the boats.', chinese: '天气晴朗时，人们会坐在户外喝咖啡、看船。',
    highlight: ['On sunny days', 'watch the boats'],
    wordTranslations: [
      { word: 'On', translation: '在' }, { word: 'sunny', translation: '晴朗的' },
      { word: 'days', translation: '日子；天' }, { word: 'people', translation: '人们' },
      { word: 'sit', translation: '坐' }, { word: 'outside', translation: '在户外' },
      { word: 'with', translation: '带着；伴着' }, { word: 'coffee', translation: '咖啡' },
      { word: 'and', translation: '和；并且' }, { word: 'watch', translation: '观看；看' },
      { word: 'the', translation: '这些（特指）' }, { word: 'boats', translation: '船只' },
    ],
  },
  {
    id: '6', start: 21, end: 26,
    english: 'The sea breeze can be cold, even in the middle of summer.', chinese: '即使在盛夏，海风也可能很冷。',
    highlight: ['sea breeze', 'in the middle of'],
    wordTranslations: [
      { word: 'The', translation: '这阵；这股（特指）' }, { word: 'sea', translation: '海' },
      { word: 'breeze', translation: '微风' }, { word: 'can', translation: '可以；可能' },
      { word: 'be', translation: '是；变得' }, { word: 'cold', translation: '冷的；寒冷的' },
      { word: 'even', translation: '甚至；即使' }, { word: 'in', translation: '在' },
      { word: 'the', translation: '这个（特指）' }, { word: 'middle', translation: '中间' },
      { word: 'of', translation: '的' }, { word: 'summer', translation: '夏天' },
    ],
  },
  {
    id: '7', start: 26, end: 31,
    english: 'So, I always bring a light jacket with me.', chinese: '所以我总会随身带一件薄外套。',
    highlight: ['bring', 'with me'],
    wordTranslations: [
      { word: 'So', translation: '所以' }, { word: 'I', translation: '我' },
      { word: 'always', translation: '总是' }, { word: 'bring', translation: '带；携带' },
      { word: 'a', translation: '一件；一个' }, { word: 'light', translation: '薄的；轻的' },
      { word: 'jacket', translation: '夹克；外套' }, { word: 'with', translation: '和；带着' },
      { word: 'me', translation: '我；我自己' },
    ],
  },
  {
    id: '8', start: 31, end: 36,
    english: 'Listen once, then try to repeat each sentence with me.', chinese: '先听一遍，然后试着和我一起重复每个句子。',
    highlight: ['repeat', 'each sentence'],
    wordTranslations: [
      { word: 'Listen', translation: '听' }, { word: 'once', translation: '一次；一遍' },
      { word: 'then', translation: '然后' }, { word: 'try', translation: '试着' },
      { word: 'to', translation: '去；不定式标志' }, { word: 'repeat', translation: '重复；复述' },
      { word: 'each', translation: '每个' }, { word: 'sentence', translation: '句子' },
      { word: 'with', translation: '和；同' }, { word: 'me', translation: '我' },
    ],
  },
]

export const filterGroups = {
  难度: ['全部', 'A1', 'A2', 'B1', 'B2', 'C1'],
  主题: ['全部', '旅行', '日常', '文化', '职场', '发音'],
  口音: ['全部', '英音', '美音', '澳音'],
}
