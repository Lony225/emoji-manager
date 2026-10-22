import { describe, expect, it } from 'vitest';
import { parseDeepLink } from '../core/deeplink';

describe('协议链接解析', () => {
  it('识别 subscribe 并取出 http(s) 地址', () => {
    const url = 'https://emoji.example.com/packs/abc/manifest.json';
    expect(parseDeepLink(`emojimanager://subscribe?url=${encodeURIComponent(url)}`)).toEqual({ action: 'subscribe', url });
    expect(parseDeepLink(`EmojiManager://Subscribe/?url=${encodeURIComponent(url)}`)).toEqual({ action: 'subscribe', url });
  });

  it('拒绝其他协议、其他动作和非 http 地址', () => {
    expect(parseDeepLink('https://example.com/?url=x')).toBeNull();
    expect(parseDeepLink('emojimanager://delete?url=https://x')).toBeNull();
    expect(parseDeepLink('emojimanager://subscribe?url=file:///etc/passwd')).toBeNull();
    expect(parseDeepLink('emojimanager://subscribe')).toBeNull();
    expect(parseDeepLink('not a url')).toBeNull();
  });
});
