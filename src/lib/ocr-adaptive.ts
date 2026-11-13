/**
 * OCR 多候选自适应选择：纯函数，不依赖 DOM / 引擎，浏览器与评测器共用。
 *
 * 背景：真实照片的最优预处理组合因图而异（白底扫描件需要二值化、木纹背景
 * 怕二值化、大图怕插值放大），靠单一启发式或「低置信度才重试」都覆盖不到。
 * 做法是跑少量候选，用不依赖参考答案的信号打分选优。
 */
import { isValidIdNumber } from './id-number';

export interface OcrCandidate {
  /** 已规范化 / 纠错 / 过滤乱码行后的最终文本 */
  text: string;
  /** 引擎自报置信度，0~100 */
  confidence: number;
  /** 诊断标识，例如 full/binary/1x */
  key: string;
  /** 该候选使用的放大倍数（1 表示原尺寸） */
  upscale?: number;
}

const VALID_RE = /[\u4e00-\u9fff0-9A-Za-z.,:;!?￥%()（）《》、。：；！？\-—~]/g;
const CJK_RE = /[\u4e00-\u9fff]/g;
/** 纹理背景被误当成文字时典型的高频乱码字母串，如 NANN / NAWRNS */
const NOISE_RE = /[NAWRS]{4,}/gi;

/**
 * 候选打分。各项权重由真实证件照片的网格实验标定，量纲统一到「分」：
 *  - 置信度为主信号（0~60 分）
 *  - 有效字符占比 / 汉字占比抑制乱码（0~25 / 0~15 分）
 *  - 18 位身份证号通过 MOD 11-2 校验是客观正信号（+12）
 *  - 纹理乱码、内容过少、无信息的插值放大分别扣分
 */
export function scoreOcrCandidate(c: OcrCandidate): number {
  const t = (c.text ?? '').replace(/\s/g, '');
  if (!t) return -1e6;
  const conf = Math.max(0, Math.min(100, c.confidence ?? 0));
  const cjk = (t.match(CJK_RE) ?? []).length;
  const good = (t.match(VALID_RE) ?? []).length;
  const valid = good / t.length;
  const noise = (t.match(NOISE_RE) ?? []).length;
  const idm = t.match(/\d{17}[\dX]/);
  const idOk = idm && isValidIdNumber(idm[0]) ? 1 : 0;
  // 双线性插值不增加信息，同分时优先原尺寸（实测三张真实照片最优解均为 1x）
  const upPenalty = (c.upscale ?? 1) > 1 ? 2 : 0;
  return conf * 0.6
    + valid * 100 * 0.25
    + (cjk / t.length) * 100 * 0.15
    + idOk * 12
    - noise * 4
    + Math.min(t.length, 220) * 0.05
    - upPenalty;
}

/**
 * 保守选优：candidates[0] 必须是 auto 启发式的基线结果。
 * 只有其他候选高出 margin 分才替换，避免清晰输入被「略高置信度但更差」的
 * 候选带偏（合成样本回归依赖这一点）。
 */
export function pickBestCandidate(
  candidates: OcrCandidate[],
  margin = 3,
): { best: OcrCandidate; baseline: OcrCandidate; switched: boolean; scores: number[] } {
  if (!candidates.length) throw new Error('pickBestCandidate: 候选为空');
  const lens = candidates.map((c) => (c.text ?? '').replace(/\s/g, '').length);
  const maxLen = Math.max(1, ...lens);
  // 相对长度惩罚：Tesseract 对「只抓到零星笔画」的输出常给出虚高置信度，
  // 单看绝对分数会压过内容完整但置信度为 0 的候选（实测高难号码样本
  // 选中 4 字符乱码而放弃 18 位号码）。内容量不足最长候选 1/3 的，
  // 视为该路基本未识别出正文。
  const scores = candidates.map((c, i) => {
    const base = scoreOcrCandidate(c);
    if (base <= -1e5) return base;
    return lens[i] / maxLen < 0.34 ? base - 25 : base;
  });
  let bestIdx = 0;
  let bestScore = scores[0];
  for (let i = 1; i < candidates.length; i++) {
    if (scores[i] > bestScore) { bestScore = scores[i]; bestIdx = i; }
  }
  const switched = bestIdx !== 0 && bestScore > scores[0] + margin;
  return {
    best: switched ? candidates[bestIdx] : candidates[0],
    baseline: candidates[0],
    switched,
    scores,
  };
}
