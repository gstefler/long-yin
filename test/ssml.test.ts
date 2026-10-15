import { describe, expect, test } from 'bun:test';
import { buildSsml, parseTtsParams, TtsValidationError } from '../src/services/ssml';

describe('parseTtsParams', () => {
  test('fills defaults and trims text', () => {
    expect(parseTtsParams({ text: ' 你好 ' })).toEqual({
      text: '你好',
      voice: 'zh-CN-XiaoxiaoNeural',
      rate: '+0%',
      pitch: '+0Hz',
      volume: '+0%',
    });
  });

  test('accepts regional voices and signed tuning', () => {
    const p = parseTtsParams({ text: '好', voice: 'zh-CN-liaoning-XiaobeiNeural', rate: '-15%', pitch: '+5Hz' });
    expect(p.voice).toBe('zh-CN-liaoning-XiaobeiNeural');
    expect(p.rate).toBe('-15%');
  });

  test.each([
    [{ text: '' }],
    [{ text: 'x'.repeat(501) }],
    [{ text: '好', voice: "zh-CN-X'/><evil" }],
    [{ text: '好', rate: '10%' }],
    [{ text: '好', pitch: '+5%' }],
  ])('rejects %j', (raw) => {
    expect(() => parseTtsParams(raw)).toThrow(TtsValidationError);
  });
});

describe('buildSsml', () => {
  const base = { text: 'a<b & "c"', voice: 'zh-CN-YunxiNeural', rate: '+0%', pitch: '+0Hz', volume: '+0%' };

  test('escapes text and takes xml:lang from the voice', () => {
    const ssml = buildSsml(base);
    expect(ssml).toContain("xml:lang='zh-CN'");
    expect(ssml).toContain('a&lt;b &amp; &quot;c&quot;');
    expect(ssml).toContain("<prosody pitch='+0Hz' rate='+0%' volume='+0%'>");
  });

  test('drops neutral prosody only when asked', () => {
    expect(buildSsml(base, { omitNeutralProsody: true })).not.toContain('<prosody');
    expect(buildSsml({ ...base, rate: '-10%' }, { omitNeutralProsody: true })).toContain("rate='-10%'");
  });
});
