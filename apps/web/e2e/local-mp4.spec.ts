import { expect, test, type Locator } from '@playwright/test'
import { statSync } from 'node:fs'
import { basename, extname } from 'node:path'

function getTestVideoPath() {
  const videoPath = process.env.E2E_MP4_PATH
  if (!videoPath) throw new Error('E2E_MP4_PATH is required and must point to the requested MP4')
  const file = statSync(videoPath)
  if (!file.isFile() || extname(videoPath).toLowerCase() !== '.mp4') throw new Error('E2E_MP4_PATH must point to an MP4 file')
  return { videoPath, fileSize: file.size, fileName: basename(videoPath) }
}

async function readCurrentTime(video: Locator): Promise<number> {
  return video.evaluate((element: HTMLVideoElement) => element.currentTime)
}

test('真实 MP4 上传、MOSS 字幕和私有学习页播放', async ({ page }, testInfo) => {
  const fixture = getTestVideoPath()
  const reuseTitle = process.env.E2E_REUSE_READY_TITLE
  const title = reuseTitle ?? `EchoFlow E2E ${Date.now()}`

  await page.goto('/')
  if (reuseTitle) {
    await page.locator('button.side-upload').click()
  } else {
    await page.getByRole('button', { name: '上传视频', exact: true }).click()

    const fileInput = page.locator('input[type="file"]')
    await fileInput.setInputFiles(fixture.videoPath)
    await expect(page.getByText(fixture.fileName, { exact: true })).toBeVisible()
    await expect(page.getByText(`${Math.round(fixture.fileSize / 1024 / 1024)} MB`, { exact: true })).toBeVisible()

    await page.getByLabel('课程标题').fill(title)
    await page.getByLabel('分类').fill('旅行')
    await page.getByLabel('口音').fill('美音')
    await page.getByLabel('难度').selectOption('A2')
    await page.getByRole('checkbox', { name: /确认拥有该视频/ }).check()
    await page.getByRole('button', { name: '上传并生成课程', exact: true }).click()

    await expect(page.getByRole('heading', { name: '个人上传', exact: true })).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText('课程已就绪', { exact: true })).toBeVisible({ timeout: 10 * 60 * 1000 })
  }

  const courseRow = page.locator('article.private-course-row').filter({ hasText: title })
  await expect(courseRow).toContainText('已就绪', { timeout: 30_000 })
  await expect(courseRow).toContainText(/字幕 · 中文 \d+\/\d+/)
  await courseRow.getByRole('button', { name: '开始学习', exact: true }).click()
  await expect(page.locator('main.private-study-page')).toBeVisible()

  const video = page.getByTestId('private-video')
  await expect(video).toBeVisible()
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1)
  const duration = await video.evaluate((element: HTMLVideoElement) => element.duration)
  expect(duration).toBeGreaterThan(300)
  expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true)

  const playToggle = page.getByTestId('private-video-toggle')
  await playToggle.click()
  await expect.poll(() => readCurrentTime(video), { timeout: 15_000 }).toBeGreaterThan(0.5)

  await playToggle.click()
  const pausedAt = await readCurrentTime(video)
  await page.waitForTimeout(1_500)
  expect(await readCurrentTime(video)).toBeCloseTo(pausedAt, 1)

  await playToggle.click()
  await expect.poll(() => readCurrentTime(video), { timeout: 15_000 }).toBeGreaterThan(pausedAt + 0.5)

  const progress = page.getByTestId('private-video-progress')
  const progressBox = await progress.boundingBox()
  if (!progressBox) throw new Error('视频进度控件没有可交互区域')
  await progress.click({ position: { x: Math.max(1, progressBox.width - 1), y: progressBox.height / 2 } })
  await expect.poll(() => readCurrentTime(video), { timeout: 15_000 }).toBeGreaterThan(duration - 2)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.ended), { timeout: 15_000 }).toBe(true)
  await expect(page.getByText('播放结束，可重新播放', { exact: true })).toBeVisible()

  await expect(page.getByRole('button', { name: '重新播放视频', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '重新播放视频', exact: true }).click()
  await expect.poll(() => readCurrentTime(video), { timeout: 15_000 }).toBeLessThan(1)

  const volume = page.getByLabel('音量')
  const volumeBox = await volume.boundingBox()
  if (!volumeBox) throw new Error('音量控件没有可交互区域')
  await volume.click({ position: { x: volumeBox.width / 2, y: volumeBox.height / 2 } })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.volume)).toBeGreaterThan(0.25)
  expect(await video.evaluate((element: HTMLVideoElement) => element.volume)).toBeLessThan(0.75)

  const muteButton = page.getByTestId('private-video-mute')
  await muteButton.click()
  expect(await video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(true)
  await muteButton.click()
  expect(await video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(false)

  await page.getByTestId('private-video-speed').selectOption('1.25')
  expect(await video.evaluate((element: HTMLVideoElement) => element.playbackRate)).toBeCloseTo(1.25)

  const cueButtons = page.locator('.cue-select')
  await expect(cueButtons.first()).toBeVisible({ timeout: 30_000 })
  expect(await cueButtons.count()).toBeGreaterThan(0)
  await expect(page.locator('.cue-copy em').first()).not.toBeEmpty()
  const selectedCue = cueButtons.nth(1)
  await selectedCue.click()
  await expect(page.locator('.cue-list li.current')).toHaveCount(1)
  await expect(page.locator('.focus-sentence')).toBeVisible()

  const cueStartMs = Number(await selectedCue.getAttribute('data-cue-start-ms'))
  const cueEndMs = Number(await selectedCue.getAttribute('data-cue-end-ms'))
  expect(cueEndMs).toBeGreaterThan(cueStartMs)
  await page.getByRole('button', { name: '单句循环', exact: true }).click()
  await expect(page.getByRole('button', { name: '单句循环', exact: true })).toHaveClass(/active/)
  await page.getByRole('button', { name: '播放本句', exact: true }).click()
  await expect.poll(() => readCurrentTime(video), { timeout: 15_000 }).toBeGreaterThanOrEqual(cueStartMs / 1000)
  await page.waitForTimeout(cueEndMs - cueStartMs + 750)
  expect(await readCurrentTime(video)).toBeLessThan((cueEndMs / 1000) - 0.05)

  const screenshot = testInfo.outputPath('private-learning-validated.png')
  await page.screenshot({ path: screenshot, fullPage: false })
  await testInfo.attach('private-learning-validated', { path: screenshot, contentType: 'image/png' })
})
