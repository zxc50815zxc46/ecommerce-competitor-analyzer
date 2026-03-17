/**
 * One-shot analysis script for a single ASIN
 * Usage: node scripts/run-analysis.js <ASIN>
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Load .env manually
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...rest] = line.split('=');
    if (k && rest.length) process.env[k.trim()] = rest.join('=').trim();
  });
}

const OLOSTEP_API_KEY = process.env.OLOSTEP_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const asin = process.argv[2] || 'B07Q3C7W2H';

function httpsPost(hostname, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname,
      path: urlPath,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) },
      timeout: 180000
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(bodyStr);
    req.end();
  });
}

async function scrape(asin) {
  const url = `https://www.amazon.com/dp/${asin}`;

  // Try v2 first
  console.log('[1/3] Scraping via Olostep v2...');
  try {
    const resV2 = await httpsPost(
      'api.olostep.com',
      '/v2/agent/web-agent',
      { 'Authorization': `Bearer ${OLOSTEP_API_KEY}`, 'Content-Type': 'application/json' },
      { url, wait_time: 10, screenshot: false, extract_dynamic_content: true, comments_number: 100 }
    );
    if (resV2.status === 200) {
      const parsed = JSON.parse(resV2.body);
      const content = parsed.markdown_content || parsed.html_content || '';
      if (content) {
        console.log(`    Got ${content.length} chars (v2)`);
        return content;
      }
    }
    console.log(`    v2 returned ${resV2.status}, trying v1...`);
  } catch (e) {
    console.log(`    v2 failed (${e.message}), trying v1...`);
  }

  // Fallback v1
  const resV1 = await httpsPost(
    'api.olostep.com',
    '/v1/scrapes',
    { 'Authorization': `Bearer ${OLOSTEP_API_KEY}`, 'Content-Type': 'application/json' },
    { url }
  );

  if (resV1.status !== 200) {
    throw new Error(`Olostep v1 error ${resV1.status}: ${resV1.body.slice(0, 300)}`);
  }
  const parsed = JSON.parse(resV1.body);
  const content = parsed.result?.markdown_content || parsed.markdown_content || parsed.content || '';
  if (!content) throw new Error(`Empty content. Raw: ${resV1.body.slice(0, 300)}`);
  console.log(`    Got ${content.length} chars (v1)`);
  return content;
}

async function analyze(productContent) {
  console.log('[2/3] Sending to Gemini for AI analysis...');

  const prompt = `你是亚马逊竞品分析专家。请分析以下产品页面的内容：

${productContent}

# Role / 身份角色

你是一位拥有 10 年经验的"亚马逊顶级运营总监"和"品牌战略官"。你不仅精通 A9和rufus算法，更擅长解析品牌背后的营销心理学与视觉工业设计逻辑。你的任务是透过 Listing 表面现象，还原对手的战略布局、设计方法论以及运营套路。

# Goal / 工作目标

对 [提供的ASIN/商品链接/文本/图片] 进行深度扫描，输出一份能够指导产品迭代和营销升级的结构化报告。

# Output / 强制输出结构

## 第一部分：文案构建逻辑与词频分析 (The Brain)

构建逻辑与方法论：
拆解其标题、五点描述、详情描述的文本构建策略。他是基于"痛点触发"、"场景驱动"还是"参数压制"？使用了什么样的叙事模板？

词频情报：
提取 Listing 全文中的 Top 10 核心关键词，并分析这些词是如何在文案中进行权重分配与埋点的。

## 第二部分：视觉资产设计思路 (The Face)

设计方法论：
分析主图与 A+ 图片的整体设计风格与视觉定位（如：极简工业风、居家生活风等）。

视觉动线拆解：
逐一说明其不同图片（功能图、场景图、对比图等）分别表达了什么核心内容？视觉上有哪些抓人眼球的特点？

设计逻辑：
分析其构图、色彩心理学应用以及字体选型，识别其视觉上的差异化"钩子"。

## 第三部分：评论定量与定性分析 (The Voice)

量化数据概览：
- 明确分析的样本量（如：前 X 条评论）及当前总评分
- 统计好评（4-5星）与差评（1-3星）的数量及百分比

定性穿透分析：
- 优势聚类：用户评论中反复提到的优点及其触发场景
- 差评穿透：差评主要体现的核心问题（区分产品缺陷、描述不符或体验感差）

核心总结 (Top 3)：
- 3 条核心优势（用户为何买他）
- 3 条核心痛点（用户为何退货/差评）
- 3 条改进建议（我该如何做得更好）

## 第四部分：市场维态与盲区扫描 (The Pulse)

市场表现：
分析其价格波动规律、评分稳定性以及在类目中的排名变动趋势。

QA 价值挖掘：
从问答区提取用户下单前的"最后一道心理防线"。

盲区扫描：
识别任何我们尚未察觉但具有威胁或机会的内容（如：特定背书、捆绑策略等）。

---

最后请你输出以下内容，包括：
1. 产品标题
2. 价格
3. 评分
4. 详细的竞品分析报告内容

不要出现任何星号、井号这类没有意义的符号`;

  const res = await httpsPost(
    'generativelanguage.googleapis.com',
    `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    { 'Content-Type': 'application/json' },
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192 }
    }
  );

  if (res.status !== 200) throw new Error(`Gemini error ${res.status}: ${res.body.slice(0, 300)}`);
  const parsed = JSON.parse(res.body);
  const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Empty response from Gemini');
  console.log(`    Got ${text.length} chars of analysis`);
  return text;
}

async function main() {
  if (!OLOSTEP_API_KEY) throw new Error('OLOSTEP_API_KEY not set');
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const productContent = await scrape(asin);
  const analysis = await analyze(productContent);

  console.log('[3/3] Saving report...');
  const date = new Date().toISOString().slice(0, 10);
  const outputDir = path.join(__dirname, '..', 'reports');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const reportPath = path.join(outputDir, `竞品分析-${asin}-${date}.md`);
  const report = `# Amazon 竞品分析报告

ASIN：${asin}
分析日期：${date}
产品链接：https://www.amazon.com/dp/${asin}

---

${analysis}
`;

  fs.writeFileSync(reportPath, report, 'utf8');
  console.log(`\n完成！报告已保存至：${reportPath}`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
