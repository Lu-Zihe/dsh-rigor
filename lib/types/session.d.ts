/** 会话日志解析（core/session.js） */

/** 逐帧解压整个多帧 zstd 文件 */
export function decompressFrames(buf: Buffer | Uint8Array): { text: string; frames: number }

/** 读取单个会话文件，返回已解析的记录数组 */
export function readSessionFile(file: string): {
  file: string
  frames: number
  records: unknown[]
}

/** 递归列出会话文件（默认 ~/.dsh/sessions） */
export function listSessionFiles(root?: string, limit?: number): string[]

export const DEFAULT_SESSIONS_ROOT: string
