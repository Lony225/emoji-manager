import { describe, expect, it } from 'vitest';
import { extFromBytes, extFromContentType, extFromName, fileStem, maybeAnimated } from './images';

describe('images', () => {
  it('extFromName 识别常见扩展名并归一化', () => {
    expect(extFromName('a.PNG')).toBe('png');
    expect(extFromName('a.jpeg')).toBe('jpg');
    expect(extFromName('/path/to/x.gif?x=1#frag')).toBe('gif');
    expect(extFromName('noext')).toBeNull();
    expect(extFromName('a.txt')).toBeNull();
  });

  it('extFromContentType', () => {
    expect(extFromContentType('image/jpeg; charset=binary')).toBe('jpg');
    expect(extFromContentType('IMAGE/WEBP')).toBe('webp');
    expect(extFromContentType('text/html')).toBeNull();
    expect(extFromContentType(null)).toBeNull();
  });

  it('extFromBytes 通过文件头识别', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);
    const gif = new Uint8Array([...'GIF89a'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0, 0, 0, 0]));
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0]);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(extFromBytes(png)).toBe('png');
    expect(extFromBytes(gif)).toBe('gif');
    expect(extFromBytes(webp)).toBe('webp');
    expect(extFromBytes(jpg)).toBe('jpg');
    expect(extFromBytes(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('svg');
    expect(extFromBytes(new Uint8Array(20))).toBeNull();
  });

  it('fileStem 去掉路径与扩展名', () => {
    expect(fileStem('C:/a/b/开心.png')).toBe('开心');
    expect(fileStem('C:\\a\\b\\哭.gif')).toBe('哭');
    expect(fileStem('x/y/z.tar.gz')).toBe('z.tar');
    expect(fileStem('%E5%93%88.gif')).toBe('哈');
    expect(fileStem('.hidden')).toBe('.hidden');
  });

  it('maybeAnimated', () => {
    expect(maybeAnimated('gif')).toBe(true);
    expect(maybeAnimated('png')).toBe(false);
  });
});
