/**
 * OCR 轻量后纠错层（保守策略）。
 *
 * 原则：只替换「在正常简体中文里绝对不成立」的错拼形式，
 * 绝不把可能本来就正确的文本改写掉。分三类：
 *
 *  1. 词级混淆表 —— Tesseract chi_sim 高频错词（错拼形式本身不成词，全局替换安全）
 *  2. 上下文规则 —— 形近字在特定后缀前必错（如「己完成」必为「已完成」）
 *  3. 字母数字混淆 —— 与数字相邻的 O→0、l/I/|→1（证件号、金额、日期场景）
 *
 * 纯规则实现、零依赖、亚毫秒级，浏览器与 Node 均可运行。
 */

/** 词级混淆表：键为「不成词的错拼」，值为正词 */
const WORD_FIXES: Record<string, string> = {
  // 曰 → 日（Tesseract 对宋体「日」的常见误识）
  曰期: '日期',
  曰常: '日常',
  曰志: '日志',
  曰程: '日程',
  曰记: '日记',
  曰报: '日报',
  曰本: '日本',
  曰子: '日子',
  曰历: '日历',
  曰出: '日出',
  曰落: '日落',
  // 只 → 识（「只别」绝不成词）
  只别: '识别',
  // 末 → 未（错拼形式不成词）
  末来: '未来',
  末必: '未必',
  末能: '未能',
  末曾: '未曾',
  末经: '未经',
  末处理: '未处理',
  末完成: '未完成',
  末使用: '未使用',
  末选择: '未选择',
  末响应: '未响应',
  // 帐 → 账（简体中文规范用字）
  帐户: '账户',
  帐号: '账号',
  帐单: '账单',
  帐面: '账面',
  // 在 → 再（音近，「在见/在次」绝不成词）
  在见: '再见',
  在次: '再次',
  // 固 → 国（「共和固」类误识）
  共和固: '共和国',
  中固: '中国',
  // 其他高频
  签暑: '签署',
  拾别: '识别',
  视别: '识别',
  清職: '清楚',
  // —— 以下来自降质样本与真实证件照片的实测混淆（均为不成词错拼） ——
  // 桌 → 果 / 着 / 泉（宋体「桌」在噪声下的三种典型误识）
  果面: '桌面',
  着面: '桌面',
  泉面: '桌面',
  // 台 → 合（「工作台」→「工作合」）
  工作合: '工作台',
  // 批 → 吉、印 → 县（「批注」「水印」）
  吉注: '批注',
  水县: '水印',
  // 离线 → 高乒、上传 → 上特
  高乒: '离线',
  上特: '上传',
  // 身 → 喘、器 → 恬（「身份证」「服务器」）
  喘份证: '身份证',
  喘份: '身份',
  服务恬: '服务器',
  // 它支 → 已文（跨行干扰导致的整词错识）
  已文持: '它支持',
};

/** 上下文规则：「己」只有出现在完成类动词前才是「已」 */
const CONTEXT_RULES: Array<{ re: RegExp; to: string }> = [
  { re: /(?<!自)己(?=经|曾|于|由|按|在)/g, to: '已' },
  {
    re: /(?<!自)己(?=完成|完成|通过|保存|删除|发送|处理|审核|批准|签署|取消|停用|启用|安装|更新|上传|下载|连接|登录|注册|提交|关闭|开启|收到|支付|发货|签收)/g,
    to: '已',
  },
  { re: /末(?=来|必|能|曾|经|成年)/g, to: '未' },
  // 字 → 子（仅限「文?提取/文?识别」等明确语境，避免误伤《文子》等专名）
  { re: /(?<=文)子(?=提取|识别|处理|流)/g, to: '字' },
  // 都 → 格（「处理格在」绝不成文）
  { re: /格(?=在本机|在本地|在页面)/g, to: '都' },
  // 括号类：中文语境中的半角引号成对替换
  { re: /([\u4e00-\u9fff（）《》「」])"(?=[\u4e00-\u9fff])/g, to: '$1“' },
  { re: /(?<=[\u4e00-\u9fff])"([\u4e00-\u9fff（）《》，。；：、？！]|$)/g, to: '”$1' },
];

/**
 * 与数字相邻的字母纠错：
 *  - O/o → 0、l/I/| → 1（证件号、编号、金额、日期）
 *  - 只在「紧邻数字」时替换，避免误伤普通英文单词
 */
function fixAlnumConfusion(text: string): string {
  return text
    .replace(/(?<=\d)[Oo]/g, '0')
    .replace(/[Oo](?=\d)/g, '0')
    .replace(/(?<=\d)[lI|]/g, '1')
    .replace(/[lI|](?=\d)/g, '1');
}

/** 常见异体字归一（简体中文语境中绝不该出现的变体） */
const VARIANT_CHARS: Record<string, string> = {
  査: '查',
  眞: '真',
  曽: '曾',
};

/**
 * 过滤 OCR 乱码行（仅中文语境使用）。
 * 纹理背景（木纹、布纹）经二值化后会产生大量「AN / NA / NN」式伪词行，
 * 特征：行内 \ N A W R S 字母占比极高且几乎无汉字数字。
 * 规则保守：只在 junk 占比 > 0.6 时丢弃，正常中英文内容不受影响。
 */
export function filterNoiseLines(text: string): string {
  return text
    .split(/\n+/)
    .filter((line) => {
      const t = line.replace(/\s/g, '');
      if (!t) return false;
      const junk = (t.match(/[\\NAWRNS]/g) ?? []).length / t.length;
      return junk < 0.6;
    })
    .join('\n');
}

/** 单条纠错是否命中（用于统计与调试） */
export function listCorrections(text: string): Array<{ from: string; to: string }> {
  const hits: Array<{ from: string; to: string }> = [];
  for (const [from, to] of Object.entries(WORD_FIXES)) {
    if (text.includes(from)) hits.push({ from, to });
  }
  for (const { re, to } of CONTEXT_RULES) {
    const m = text.match(new RegExp(re.source, 'g'));
    if (m) hits.push({ from: re.source, to });
  }
  return hits;
}

/**
 * 对 OCR 输出做保守后纠错。
 * 输入应是已过 normalizeOcrText 的文本（本函数不做空白/标点清理）。
 */
export function correctOcrText(text: string): string {
  if (!text) return text;

  let out = text;

  // 1. 词级混淆表（按长度降序，避免短词先替换破坏长词匹配）
  const entries = Object.entries(WORD_FIXES).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [from, to] of entries) {
    if (out.includes(from)) out = out.split(from).join(to);
  }

  // 2. 上下文规则
  for (const { re, to } of CONTEXT_RULES) {
    out = out.replace(re, to);
  }

  // 3. 字母数字混淆
  out = fixAlnumConfusion(out);

  // 4. 货币符号统一：中文语境的半角 ¥ 一律视为人民币全角 ￥，并去掉其后空格
  out = out.replace(/¥\s*/g, '￥');

  // 5. 异体字归一
  for (const [from, to] of Object.entries(VARIANT_CHARS)) {
    if (out.includes(from)) out = out.split(from).join(to);
  }

  return out;
}
