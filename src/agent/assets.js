// The asset shape the scope watch stores, shared by the platform adapters. Pure functions.

export const CATEGORIES = ['web', 'wildcard', 'api', 'network', 'android', 'ios', 'executable', 'source_code', 'hardware', 'iot', 'cloud', 'blockchain', 'ai_model', 'other'];
export const SEVERITIES = ['none', 'low', 'medium', 'high', 'critical'];

// One kind of asset across platforms, so an agent can ask for "wildcard" or "android" anywhere.
export function category(rawType, identifier = '') {
  const t = String(rawType || '').toLowerCase().replace(/[\s-]+/g, '_');
  const id = String(identifier);
  if (/\*|\{[^}]*\}/.test(id) && /\./.test(id) && !/^(api|other|code|source_code)$/.test(t)) return 'wildcard';
  const map = {
    url: 'web', domain: 'web', website: 'web', wildcard: 'wildcard', api: 'api',
    cidr: 'network', ip_address: 'network', network: 'network', ip_range: 'network',
    google_play_app_id: 'android', other_apk: 'android', android: 'android', android_app: 'android',
    apple_store_app_id: 'ios', testflight: 'ios', other_ipa: 'ios', ios: 'ios', ios_app: 'ios',
    windows_app_store_app_id: 'executable', downloadable_executables: 'executable', executable: 'executable',
    source_code: 'source_code', code: 'source_code', hardware: 'hardware', iot: 'iot',
    cloud: 'cloud', aws_cloud_config: 'cloud', smart_contract: 'blockchain', blockchain: 'blockchain',
    ai_model: 'ai_model',
  };
  return map[t] || 'other';
}

// A short, stable fingerprint of free text, so an edited note shows as a change without storing it.
export function textHash(s) {
  let h = 0x811c9dc5;
  for (const c of String(s || '').trim()) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return s ? h.toString(36) : '';
}

