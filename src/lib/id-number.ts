/**
 * 身份证号纯工具：MOD 11-2 校验、OCR 混淆字符规范化。
 * 无浏览器依赖，可独立单测；字段级识别流程见 idcard.ts 的 extractIdNumber。
 */

/** GB 11643-1999 MOD 11-2 校验：位置加权与校验字符表 */
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = '10X98765432';

/** 18 位身份证号校验码验证（客观判定识别对错，不依赖 ground truth） */
export function isValidIdNumber(id: string): boolean {
  if (!/^\d{17}[\dX]$/.test(id)) return false;
  const sum = ID_WEIGHTS.reduce((n, w, i) => n + Number(id[i]) * w, 0);
  return ID_CHECK[sum % 11] === id[17];
}

/** 由前 17 位算出应有的校验位 */
export function expectedCheckDigit(first17: string): string {
  const sum = ID_WEIGHTS.reduce((n, w, i) => n + Number(first17[i]) * w, 0);
  return ID_CHECK[sum % 11];
}

/** OCR 混淆字符规范化：O/o→0、l/I/|→1、x→X，去分隔符与空白 */
export function normalizeIdChars(s: string): string {
  return s
    .replace(/[Oo]/g, '0')
    .replace(/[lI|]/g, '1')
    .replace(/[x×]/g, 'X')
    .replace(/[^0-9X]/g, '');
}

/** 从任意 OCR 文本中提取首个 18 位号码形态的候选（未做校验） */
export function findIdCandidate(text: string): string | undefined {
  return normalizeIdChars(text).match(/\d{17}[\dX]/)?.[0];
}
