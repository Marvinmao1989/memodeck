/**
 * ULID 生成器。
 *
 * 为什么不用自增 ID：多设备同时新建记录时自增 ID 会冲突；随机 UUID 虽不冲突
 * 但字典序无序，查询时必须额外 ORDER BY created_at。ULID 把 48 位毫秒时间戳
 * 和 80 位随机数拼在一起，字典序近似时间序，插入的位置天然靠前。
 *
 * 参考规范：https://github.com/ulid/spec
 */

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10 // 48 位时间戳 / 5
const RANDOM_LEN = 16 // 80 位随机数 / 5
const RANDOM_BYTES = 10 // 80 bit = 10 byte

/** 把毫秒时间戳编码成 10 位 base32（48 位） */
function encodeTime(now: number): string {
  let remaining = now
  let out = ''
  for (let i = 0; i < TIME_LEN; i += 1) {
    out = CROCKFORD_BASE32[remaining % 32] + out
    remaining = Math.floor(remaining / 32)
  }
  return out
}

/** 把 10 字节随机数编码成 16 位 base32（80 位） */
function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_BYTES)
  globalThis.crypto.getRandomValues(bytes)

  let bitString = ''
  for (const b of bytes) {
    bitString += b.toString(2).padStart(8, '0')
  }

  let out = ''
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    const chunk = bitString.slice(i * 5, i * 5 + 5)
    out += CROCKFORD_BASE32[parseInt(chunk, 2)]
  }
  return out
}

/**
 * 生成 ULID。
 *
 * 注意：同一毫秒内生成的多个 ULID，其随机部分不保证单调递增，
 * 因此"字典序 = 时间序"只精确到毫秒级。需要毫秒内有序时，
 * 由调用方保证同一毫秒内只生成一个，或引入单调计数器。
 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom()
}

/** 判断字符串是否为格式合法的 ULID */
export function isUlid(value: string): boolean {
  if (value.length !== TIME_LEN + RANDOM_LEN) return false
  return [...value].every((c) => CROCKFORD_BASE32.includes(c))
}

/**
 * 机器身份。首次启动生成一次并持久化，同步时作为变更来源标记。
 * 不是用户身份 —— 用户身份来自登录的账号。
 */
export function newDeviceId(): string {
  return `dev_${ulid()}`
}
