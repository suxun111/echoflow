// 浏览器只负责提前反馈；Worker 通过 ffprobe 使用 contracts 中的同一产品规则作最终裁决。
// 这些值不能从 CommonJS contracts 包作运行时导入，否则 Vite 生产构建无法解析该导出。
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024
export const MAX_UPLOAD_DURATION_MS = 60 * 60 * 1000
