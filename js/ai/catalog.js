/**
 * 星空画布 · 能力目录（静态内置版）
 * ------------------------------------------------------------------
 * 静态部署（Netlify / 单文件）没有后端代理时，`./api/providers` 取不到，
 * 代码会退化到 `FALLBACK_CATALOG`——那里面只有 Pollinations 免费模型和本地引擎，
 * 导致「自备 Key」的接口在设置面板里根本不出现，等于接口预留没生效。
 *
 * 本文件把完整能力目录内联注入 `window.__STARRY_INLINE__`，让静态模式也能：
 *   1. 在「设置 · AI 接口」看到全部供应商（免费 + 自备 Key + 本地引擎）；
 *   2. openai-compat 类接口（DeepSeek / 通义千问 / 智谱 / Kimi / OpenAI 等）浏览器直连可用；
 *   3. 通义万相 / 百度智能云 / remove.bg 等需要后端代理的接口，配置入口与说明齐全。
 *
 * 说明：这里每个 provider 都显式声明能力、默认模型、是否需要 Key、预设平台。
 * 生成模式 / 尺寸 / 导出格式与旧版目录保持一致。
 */
window.__STARRY_INLINE__ = window.__STARRY_INLINE__ || {};

window.__STARRY_INLINE__.catalog = {
  version: '1.2.0-inline',
  capabilities: [
    { id: 'chat', label: '智能对话' },
    { id: 'image', label: '文生图 / 图生图' },
    { id: 'vision', label: '看图理解（反推提示词）' },
    { id: 'upscale', label: '变清晰（超分）' },
    { id: 'matting', label: '抠图（主体分离）' },
    { id: 'video', label: '视频生成' }
  ],
  providers: [
    /* ---------- 免费模型（服务端转发，无需 Key） ---------- */
    {
      id: 'sd3-gradio',
      label: 'Stable Diffusion 3（免费高清）',
      kind: 'free',
      needsKey: false,
      note: '免费高清文生图（SD3-Medium 1024×1024，由服务端经公共推理空间转发）。原生高清无水印，无需放大。出图清晰细腻。',
      capabilities: {
        image: {
          defaultModel: 'sd3-medium',
          models: [{ id: 'sd3-medium', label: 'SD3-Medium（默认，1024 高清）' }],
          maxSize: 1344
        }
      }
    },
    {
      id: 'pollinations',
      label: 'Pollinations 免费模型',
      kind: 'free',
      needsKey: false,
      note: '备用免费通道：文生图（Flux / Sana 等）与智能对话（OpenAI 开源模型）。出图请求强制携带 nologo=true，浏览器端再叠加像素级去水印，任何图片都不含水印。间歇性限流时自动重试或回退。',
      capabilities: {
        chat: {
          defaultModel: 'openai',
          models: [
            { id: 'openai', label: 'GPT-OSS 20B（推理）' },
            { id: 'openai-fast', label: 'GPT-OSS 20B（快速）' },
            { id: 'mistral', label: 'Mistral' },
            { id: 'llama', label: 'Llama' },
            { id: 'qwen', label: 'Qwen' },
            { id: 'gemini', label: 'Gemini' }
          ]
        },
        image: {
          defaultModel: 'flux',
          models: [
            { id: 'flux', label: 'Flux（默认，质量更好）' },
            { id: 'sana', label: 'Sana（轻量快速）' },
            { id: 'turbo', label: 'Turbo（快速）' },
            { id: 'sdxl', label: 'SDXL（高质量）' }
          ],
          maxSize: 2048
        }
      }
    },
    /* ---------- 自备 Key：OpenAI 兼容（静态模式可浏览器直连 chat / vision） ---------- */
    {
      id: 'openai-compat',
      label: 'OpenAI 兼容接口（自备 Key）',
      kind: 'byok',
      needsKey: true,
      baseUrlLabel: 'Base URL（通常以 /v1 结尾）',
      keyLabel: 'API Key',
      note: '可接入 DeepSeek / 通义千问 / 智谱 GLM / Kimi / OpenAI 等任意 OpenAI 兼容接口。静态版下「对话 / 看图反推」可浏览器直连；文生图等需后端代理的能力请在「能力路由」中分配，或运行 node server.js 完整版。',
      presets: [
        { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', chatModels: ['glm-4-flash', 'glm-4-plus', 'glm-4v-flash', 'glm-4v-plus'], vision: true, imageModels: ['cogview-3-flash'], free: true },
        { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', chatModels: ['deepseek-chat', 'deepseek-reasoner'], vision: true },
        { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', chatModels: ['qwen-plus', 'qwen-turbo', 'qwen-vl-max'], vision: true, imageModels: ['qwen-image'] },
        { label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', chatModels: ['moonshot-v1-8k', 'moonshot-v1-32k'] },
        { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', chatModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'], vision: true, imageModels: ['dall-e-3', 'gpt-image-1'] },
        { label: '豆包（火山方舟 Seedream）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', chatModels: ['doubao-seed-1-6-250615', 'doubao-lite-32k-250615'], vision: false, imageModels: ['doubao-seedream-3-0-t2i-250528'], imageOnly: true }
      ],
      capabilities: {
        chat: { defaultModel: 'glm-4-flash', models: ['glm-4-flash', 'glm-4-plus', 'glm-4v-flash', 'deepseek-chat', 'deepseek-reasoner', 'qwen-plus', 'qwen-turbo', 'qwen-vl-max', 'moonshot-v1-8k', 'gpt-4o-mini', 'gpt-4o', 'doubao-seed-1-6-250615'] },
        vision: { defaultModel: 'glm-4v-flash', models: ['glm-4v-flash', 'glm-4v-plus', 'qwen-vl-max', 'gpt-4o-mini', 'gpt-4o'] },
        image: { defaultModel: 'cogview-3-flash', models: ['cogview-3-flash', 'qwen-image', 'dall-e-3', 'gpt-image-1', 'doubao-seedream-3-0-t2i-250528'] }
      }
    },
    /* ---------- 自备 Key：通义万相（需后端代理） ---------- */
    {
      id: 'dashscope-native',
      label: '通义万相（自备 Key）',
      kind: 'byok',
      needsKey: true,
      keyLabel: 'DashScope API Key',
      note: '阿里云通义万相：文生图（wanx）、文生视频。浏览器无法跨域直连，请在项目目录运行 node server.js 后由后端代理转发。',
      capabilities: {
        image: { defaultModel: 'wanx2.1-t2i-turbo', models: ['wanx2.1-t2i-turbo', 'wanx2.1-t2i-plus', 'wanx-v1'] },
        video: { defaultModel: 'wanx2.1-t2v-turbo', models: ['wanx2.1-t2v-turbo', 'wanx2.1-t2v-plus'] }
      }
    },
    /* ---------- 自备 Key：百度智能云（需后端代理） ---------- */
    {
      id: 'baidu-aip',
      label: '百度智能云（自备 Key）',
      kind: 'byok',
      needsKey: true,
      keyLabel: 'API Key',
      secretLabel: 'Secret Key',
      note: '百度智能云 AI 服务：人像分割（抠图）、图像超分。浏览器无法跨域直连，请在项目目录运行 node server.js 后由后端代理转发。',
      capabilities: {
        upscale: { defaultModel: 'image_super_resolution', models: ['image_super_resolution'] },
        matting: { defaultModel: 'body_seg', models: ['body_seg', 'selfie_seg'] }
      }
    },
    /* ---------- 自备 Key：remove.bg（需后端代理） ---------- */
    {
      id: 'removebg',
      label: 'remove.bg（自备 Key）',
      kind: 'byok',
      needsKey: true,
      keyLabel: 'remove.bg API Key',
      note: '专业抠图服务 remove.bg。浏览器无法跨域直连，请在项目目录运行 node server.js 后由后端代理转发。',
      capabilities: {
        matting: { defaultModel: 'auto', models: ['auto'] }
      }
    },
    /* ---------- 本地引擎（离线免费） ---------- */
    {
      id: 'local',
      label: '本地引擎（离线免费）',
      kind: 'local',
      needsKey: false,
      note: '浏览器内本地计算：变清晰＝多级重采样+反锐化掩模；抠图＝颜色连通域分割+羽化；看图＝像素统计生成提示词；视频＝MediaRecorder 运镜合成 WebM。全部在本机完成，素材不上传、不消耗额度、无水印。',
      capabilities: {
        upscale: { defaultModel: 'local-upscale' },
        matting: { defaultModel: 'local-matting' },
        video: { defaultModel: 'local-video' },
        vision: { defaultModel: 'local-analyze' }
      }
    }
  ],
  generationModes: [
    { id: 'main', label: '主图', desc: '电商主图：主体突出、背景干净、适合做货架主图', promptTemplate: '电商主图，{subject}', defaultSize: '1:1', suggestSizes: ['1:1', '3:4'], negative: 'text, watermark, logo, cropped, worst quality, low quality', postProcess: [] },
    { id: 'whitebg', label: '白底图', desc: '纯白背景商品图，符合各平台白底规范', promptTemplate: '纯白背景商品图，{subject}', defaultSize: '1:1', suggestSizes: ['1:1'], negative: 'text, watermark, logo, shadow, colored background, worst quality', postProcess: ['whiteBackground'] },
    { id: 'detail', label: '详情页', desc: '电商详情页配图：场景化、信息更丰富', promptTemplate: '电商详情页配图，{subject}', defaultSize: '3:4', suggestSizes: ['3:4', '2:3'], negative: 'text, watermark, logo, worst quality', postProcess: [] },
    { id: 'video', label: '视频', desc: '生成多帧后用运镜合成，或走云端文生视频', promptTemplate: '{subject}', defaultSize: '9:16', suggestSizes: ['9:16', '16:9', '1:1'], negative: '', postProcess: [] },
    { id: 'free', label: '自由创作', desc: '完全按你的提示词自由生成', promptTemplate: '{subject}', defaultSize: '1:1', suggestSizes: ['1:1', '3:4', '16:9'], negative: '', postProcess: [] }
  ],
  sizePresets: [
    { id: '1:1', label: '1:1 方形', ratio: [1, 1], width: 1024, height: 1024 },
    { id: '3:4', label: '3:4 竖版', ratio: [3, 4], width: 896, height: 1152 },
    { id: '16:9', label: '16:9 宽屏', ratio: [16, 9], width: 1280, height: 720 },
    { id: 'custom', label: '自定义尺寸', ratio: null, width: 0, height: 0 }
  ],
  exportFormats: [
    { id: 'png', label: 'PNG（无损）', mime: 'image/png' },
    { id: 'jpeg', label: 'JPEG（压缩）', mime: 'image/jpeg' },
    { id: 'webp', label: 'WebP（高效）', mime: 'image/webp' },
    { id: 'svg', label: 'SVG（矢量文本层）', mime: 'image/svg+xml' },
    { id: 'webm', label: 'WebM 视频（本地合成）', mime: 'video/webm' },
    { id: 'json', label: 'JSON 工程存档', mime: 'application/json' }
  ],
  toolRegistry: []
};
