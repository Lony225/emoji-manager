// 协议链接解析（纯函数，便于测试）

/** 解析 emojimanager://subscribe?url=… 这样的链接；不认识的返回 null */
export function parseDeepLink(link: string): { action: 'subscribe'; url: string } | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== 'emojimanager:') return null;
  const action = (u.host || u.pathname.replace(/^\/+/, '')).toLowerCase();
  if (action !== 'subscribe') return null;
  const target = u.searchParams.get('url')?.trim() ?? '';
  if (!/^https?:\/\/\S+$/i.test(target) || target.length > 2048) return null;
  return { action: 'subscribe', url: target };
}

