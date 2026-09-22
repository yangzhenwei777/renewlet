import { scrypt as nodeScrypt } from "node:crypto";
import { base64Url, base64UrlToBytes, timingSafeEqualBytes } from "./encoding";

const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 32;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 5;
const SCRYPT_MAXMEM_BYTES = 32 * 1024 * 1024;

/**
 * randomToken 生成 bearer/session 等不可预测 token。
 *
 * 返回值使用 base64url，避免 token 放入 HTTP header、URL 或 JSON 时引入额外转义差异。
 */
export function randomToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64Url(data);
}

/**
 * sha256 为会话 token 生成 D1 可查询 hash。
 *
 * 明文 token 只存在于浏览器端，数据库泄漏时攻击者不能直接复用 session。
 */
export async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64Url(new Uint8Array(digest));
}

/**
 * hashPassword 使用固定参数的 scrypt 格式保存用户密码。
 *
 * 参数写入 hash 字符串是为了让 verifyPassword 拒绝未知或被降级的存量格式，而不是静默接受弱配置。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(PASSWORD_SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_MAXMEM_BYTES);
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${PASSWORD_HASH_BYTES}:${base64Url(salt)}:${base64Url(hash)}`;
}

/**
 * verifyPassword 校验当前正式 scrypt 密码格式。
 *
 * Renewlet 采用彻底切换，不在 Cloudflare 运行面保留旧 hash 兼容；异常格式一律认证失败。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, nText, rText, pText, keyBytesText, saltText, hashText] = stored.split(":");
  if (scheme !== "scrypt" || !nText || !rText || !pText || !keyBytesText || !saltText || !hashText) return false;
  const n = parsePositiveInteger(nText);
  const r = parsePositiveInteger(rText);
  const p = parsePositiveInteger(pText);
  const keyBytes = parsePositiveInteger(keyBytesText);
  if (!n || !r || !p || !keyBytes) return false;
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P || keyBytes !== PASSWORD_HASH_BYTES) return false;
  const expected = base64UrlToBytes(hashText);
  if (expected.length !== PASSWORD_HASH_BYTES) return false;
  const actual = await scrypt(password, base64UrlToBytes(saltText), n, r, p, SCRYPT_MAXMEM_BYTES);
  return timingSafeEqualBytes(actual, expected);
}

async function scrypt(
  password: string,
  salt: Uint8Array,
  cost: number,
  blockSize: number,
  parallelization: number,
  maxmem: number,
): Promise<Uint8Array> {
  // Workers 生产环境把 PBKDF2 卡在 100000 次；scrypt 采用 OWASP 的 16 MiB 档，避免撞 isolate 内存上限。
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      PASSWORD_HASH_BYTES,
      { cost, blockSize, parallelization, maxmem },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(new Uint8Array(derivedKey));
      },
    );
  });
}

function parsePositiveInteger(input: string): number | null {
  if (!/^[1-9]\d*$/.test(input)) return null;
  const value = Number.parseInt(input, 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}
