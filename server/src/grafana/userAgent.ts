// Deliberately hand-rolled rather than a dependency like ua-parser-js — this
// project avoids adding dependencies where a small amount of code covers
// what's actually needed (see CLAUDE.md), and the Grafana integration only
// ever needs coarse, non-identifying buckets (see GRAFANA.md's privacy
// section), not a precise version-by-version breakdown a real UA parser
// would provide.
export interface UserAgentInfo {
  deviceType: 'mobile' | 'tablet' | 'desktop' | 'other';
  os: 'ios' | 'android' | 'other';
  browser: 'safari' | 'chrome' | 'firefox' | 'other';
}

export function classifyUserAgent(ua: string | undefined): UserAgentInfo {
  const s = ua ?? '';

  const os: UserAgentInfo['os'] = /iphone|ipad|ipod/i.test(s)
    ? 'ios'
    : /android/i.test(s)
      ? 'android'
      : 'other';

  const deviceType: UserAgentInfo['deviceType'] = /ipad|android(?!.*mobile)|tablet/i.test(s)
    ? 'tablet'
    : /iphone|ipod|android.*mobile|mobile/i.test(s)
      ? 'mobile'
      : /mozilla|windows|macintosh|linux/i.test(s)
        ? 'desktop'
        : 'other';

  // Order matters: Chrome/Edge/Firefox UAs all also contain "Safari" (as
  // part of their own compatibility string), so Safari has to be checked
  // last, after ruling those out.
  const browser: UserAgentInfo['browser'] = /firefox/i.test(s)
    ? 'firefox'
    : /chrome|chromium|crios|edg/i.test(s)
      ? 'chrome'
      : /safari/i.test(s)
        ? 'safari'
        : 'other';

  return { deviceType, os, browser };
}
