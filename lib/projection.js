/**
 * dsh-mcp-switch — MCP 结果投影。
 *
 * 把 MCP 的 `CallToolResult.content` 投影成 dsh 的 ContentBlock 词表：
 *
 *   - 文本块：相邻的合并成一段（与官方客户端的行为一致）
 *   - 图片块：解码 → 经 attachments 服务持久化 → `{type:'image', attachment: ref}`
 *   - 其它块（audio / resource / resource_link）：降级为占位文本
 *
 * 三条刻意的取舍：
 *
 *   1. **图片在 execute 阶段就落盘**，而不是留给 render。
 *      dsh 的 `render(args, value)` 是同步的，而 `saveImages` 是异步的。
 *      官方客户端为此用 WeakMap + projectContent 回调绕了一圈；我们把已落盘的
 *      引用直接放进 canonical value，`render` 退化成一次数组返回。
 *
 *   2. **canonical value 里不留原始 base64。**
 *      官方客户端保留原始 content（"raw image data remains available to
 *      programmatic callers"）。我们不留 —— 一张截图就是几百 KB 的 base64，
 *      而 PTC 的程序会原样拿到 canonical value。需要字节的调用方走附件服务。
 *
 *   3. **图片准入失败不抛错，降级为文本诊断。**
 *      模型不支持图片输入、附件服务没挂、路由解析不出来 —— 这些都是环境问题，
 *      不该让一次工具调用失败。MCP 的原始文本仍然完整送达。
 */

/** 附件服务接受的闭合词表；与 `ImageMediaType` 一致。 */
const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** 规范 base64（无别名、无 URL-safe 变体）。 */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** 窄化成一个字符串键的对象。 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 该结果里有没有声明式图片块。 */
export function containsImage(content) {
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'image');
}

/**
 * 解码一个 MCP 图片块。
 *
 * 刻意严格：媒体类型必须在闭合词表内，数据必须是规范 base64 且能原样回编。
 * 宽松解析会把畸形数据带进附件存储。
 *
 * @param block - MCP 的 image 内容块
 * @returns `{ data, mediaType }`，可直接喂给 `saveImages`
 * @throws {Error} 媒体类型不受支持或数据不是规范 base64
 */
export function decodeImageBlock(block) {
  if (!IMAGE_MEDIA_TYPES.includes(block?.mimeType)) {
    throw new Error('the declared media type is not PNG, JPEG, WebP, or GIF');
  }
  if (typeof block.data !== 'string' || !CANONICAL_BASE64.test(block.data)) {
    throw new Error('the image data is not canonical base64');
  }
  const data = Buffer.from(block.data, 'base64');
  if (data.toString('base64') !== block.data) {
    throw new Error('the image data is not canonical base64');
  }
  return { data, mediaType: block.mimeType };
}

/** 被降级块的可读占位文本。 */
export function blockPlaceholder(block) {
  if (block?.type === 'image') return '[image]';
  if (block?.type === 'audio') return `[audio: ${block.mimeType ?? 'unknown media type'}]`;
  if (block?.type === 'resource_link') return `[resource link: ${block.uri ?? 'unknown uri'}]`;
  if (block?.type === 'resource') return `[resource: ${block.resource?.uri ?? 'unknown uri'}]`;
  return `[unsupported content block: ${String(block?.type ?? 'unknown')}]`;
}

/**
 * 从 MCP content 里抽出纯文本：文本块拼接，非文本块用占位符代替，块间换行。
 *
 * 用于构造 `isError` 时的错误正文 —— 必须**保真**，因为它就是模型据以纠正的全部信息。
 *
 * @param content - MCP content 数组
 * @returns 单段文本
 */
export function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content.map((block) => (block?.type === 'text' ? String(block.text ?? '') : blockPlaceholder(block))).join('\n');
}

/**
 * 解析当前模型路由是否准入图片，并在准入时返回附件服务。
 *
 * @param ctx - 插件上下文
 * @param exec - 本次工具执行（提供 agent 与最新的模型路由）
 * @returns `{ attachments }` 或 `{ reason }`
 */
async function resolveImageAdmission(ctx, exec) {
  const attachments = ctx.get?.('attachments');
  if (attachments === undefined) return { reason: 'no attachment store is mounted' };

  const routed = exec?.agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec?.agent?.options?.provider;
  const model = routed?.model ?? exec?.agent?.options?.model;
  if (provider === undefined || model === undefined) {
    return { reason: 'the current model route could not be resolved' };
  }

  const llm = ctx.get?.('llm');
  if (llm === undefined) return { reason: 'no llm service is mounted' };
  let info;
  try {
    info = await llm.resolveModelInfo(provider, model, exec?.signal);
  } catch {
    return { reason: 'the current model route could not be verified' };
  }
  if (info?.inputModalities === undefined || !info.inputModalities.includes('image')) {
    return { reason: `model "${model}" does not declare image input` };
  }
  if (exec?.signal?.aborted === true) return { reason: 'the tool call was canceled before image storage' };
  return { attachments };
}

/** 把整批图片降级为文本诊断（任一张不合法，则整批降级）。 */
function degradeImages(content, reason) {
  return content.map((block) => (block?.type === 'image'
    ? { type: 'text', text: `[image unavailable: ${block.mimeType ?? 'unknown media type'}; ${reason}; raw image data is not retained]` }
    : block));
}

/**
 * 把 MCP content 投影成 dsh 的 ContentBlock 数组。
 *
 * 相邻文本块会合并；图片块在准入成功时变成附件引用，否则变成文本诊断。
 *
 * @param ctx - 插件上下文
 * @param exec - 本次工具执行
 * @param content - MCP content 数组
 * @returns ContentBlock 数组
 */
export async function projectMcpContent(ctx, exec, content) {
  const blocks = Array.isArray(content) ? content : [];

  let effective = blocks;
  /** @type {Map<number, object>} 块下标 → 附件引用 */
  const attachmentAt = new Map();

  if (containsImage(blocks)) {
    const indexes = [];
    const decoded = [];
    let failure;
    for (const [index, block] of blocks.entries()) {
      if (block?.type !== 'image') continue;
      try {
        decoded.push(decodeImageBlock(block));
        indexes.push(index);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    if (failure === undefined) {
      const admission = await resolveImageAdmission(ctx, exec);
      if (admission.reason !== undefined) failure = admission.reason;
      else {
        try {
          const refs = await admission.attachments.saveImages(decoded);
          indexes.forEach((index, offset) => attachmentAt.set(index, refs[offset]));
        } catch (error) {
          failure = `image storage rejected the result: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
    if (failure !== undefined) effective = degradeImages(blocks, failure);
  }

  // 相邻文本块合并；图片块变附件引用。
  const out = [];
  for (const [index, block] of effective.entries()) {
    if (block?.type === 'text') {
      const text = String(block.text ?? '');
      const last = out[out.length - 1];
      if (last?.type === 'text') last.text = last.text.length === 0 ? text : `${last.text}\n${text}`;
      else out.push({ type: 'text', text });
      continue;
    }
    const ref = attachmentAt.get(index);
    if (ref !== undefined) {
      out.push({ type: 'image', attachment: ref });
      continue;
    }
    out.push({ type: 'text', text: blockPlaceholder(block) });
  }
  // 空产出**不是错误**，但也不能什么都不给：模型会看到一次「成功却空白」的调用，
  // 与「调用根本没发生」无法区分。官方客户端对同一情形返回 `… returned no model-visible content`。
  // 占位放进 canonical value，所以原生与 PTC 两条路径同时拿到它。
  if (out.length === 0) {
    out.push({ type: 'text', text: '(the MCP server returned no model-visible content)' });
  }
  return out;
}
