import { expect, test } from '@playwright/test'

test('移动端可以进入私有课程并返回个人上传列表', async ({ page }, testInfo) => {
  await page.goto('/')

  const mobileNavigation = page.getByRole('navigation', { name: '移动端主导航' })
  await expect(mobileNavigation).toBeVisible()
  await expect(page.getByRole('button', { name: '个人上传', exact: true })).toBeVisible()

  await page.getByRole('button', { name: '个人上传', exact: true }).click()
  await expect(page.getByRole('heading', { name: '个人上传', exact: true })).toBeVisible()

  const readyCourse = page.locator('article.private-course-row').filter({ hasText: '已就绪' }).first()
  await expect(readyCourse).toBeVisible()
  await expect(readyCourse.getByRole('button', { name: '开始学习', exact: true })).toBeVisible()

  const failedCourse = page.locator('article.private-course-row').filter({ hasText: '处理失败' }).first()
  if (await failedCourse.count()) await expect(failedCourse).toContainText('请在上方重试任务')

  await readyCourse.getByRole('button', { name: '开始学习', exact: true }).click()
  await expect(page.locator('main.private-study-page')).toBeVisible()
  const screenshot = testInfo.outputPath('mobile-private-course.png')
  await page.screenshot({ path: screenshot, fullPage: false })
  await testInfo.attach('mobile-private-course', { path: screenshot, contentType: 'image/png' })
  await page.getByRole('button', { name: '返回上传课程', exact: true }).click()
  await expect(page.getByRole('heading', { name: '个人上传', exact: true })).toBeVisible()
})
